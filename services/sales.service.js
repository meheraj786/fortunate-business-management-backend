const Sales = require("../models/sales.model");
const Product = require("../models/product.model");
const Customer = require("../models/customer.model");
const Unit = require("../models/unit.model");
const { ApiError } = require("../utils/ApiError");
const { startOfDay, now, formatInTimeZone, DEFAULT_TIMEZONE } = require("../utils/timezone.util");
const Transaction = require("../models/transaction.model");
const Account = require("../models/account.model");
const DailyCash = require("../models/dailyCash.model");
const { formatAccountLabel } = require("../utils/format.util");
const mathUtil = require("../utils/math.util");
const CreditHistory = require("../models/creditHistory.model");

/**
 * Generates a new sequential Sale ID (e.g., SALE-24-000001)
 */
const Counter = require("../models/counter.model");

/**
 * Generates a new sequential Sale ID (e.g., SALE-24-000001)
 * Uses a persistent Counter model to ensure IDs are never reused, even if sales are deleted.
 */
exports.generateSaleId = async () => {
  // Use the business timezone to determine the current year, ensuring ID sequences align with the business day.
  // This prevents "future" IDs (e.g. 2025 IDs in 2024) if the server is behind, or vice versa.
  const currentYearStr = formatInTimeZone(new Date(), "yyyy", DEFAULT_TIMEZONE);
  const currentYear = parseInt(currentYearStr, 10);
  const shortYear = currentYearStr.slice(-2);
  const counterId = `saleId_${shortYear}`;

  // 1. Atomically increment the counter
  // usage of findOneAndUpdate with upsert ensures we handle concurrency
  let counter = await Counter.findByIdAndUpdate(
    counterId,
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );

  // 2. SELF-HEALING / INITIALIZATION CHECK
  // If the counter was just created (seq === 1), it might be lower than existing legacy IDs.
  // We must synchronize with the max existing Sales ID to avoid collisions.
  if (counter.seq === 1) {
    const lastSale = await Sales.findOne({
      saleId: new RegExp(`^SALE-${shortYear}-`, "i"),
    }).sort({ saleId: -1 });

    let maxLegacyId = 0;
    if (lastSale && lastSale.saleId) {
      const match = lastSale.saleId.match(/(\d+)$/);
      if (match) {
        maxLegacyId = parseInt(match[1], 10);
      }
    }

    if (maxLegacyId >= 1) {
      // We found existing sales. Update counter to max + 1
      // note: we already incremented to 1 above, so we effectively want the next ID to be max+1.
      // So set seq to maxLegacyId + 1.
      counter = await Counter.findByIdAndUpdate(
        counterId,
        { $set: { seq: maxLegacyId + 1 } },
        { new: true }
      );
    }
  }

  return `SALE-${shortYear}-${counter.seq.toString().padStart(6, "0")}`;
};

/**
 * Validates that the sale date is not in the future
 */
exports.validateSaleDate = (saleDate, timezone) => {
  if (!saleDate) return;
  const today = startOfDay(now(), timezone);
  const providedSaleDate = startOfDay(new Date(saleDate), timezone);

  if (providedSaleDate > today) {
    throw new ApiError(400, "Sale date cannot be in the future.");
  }
};

/**
 * Checks if stock is available and validates unit compatibility for multiple items
 * Returns a list of deductions to be applied
 */
exports.validateStockForItems = async (items, warehouseId, session) => {
  const deductions = [];
  const productQuantities = new Map(); // productId -> { baseUnitRequests: [] }

  // Collect all IDs for batch fetching
  const unitIds = [...new Set(items.map((i) => i.unit))];
  const productIds = [...new Set(items.map((i) => i.product))];

  // Batch Fetch
  // Serialized Fetch to prevent transaction race conditions
  const units = await Unit.find({ _id: { $in: unitIds } }).session(session);
  const products = await Product.find({ _id: { $in: productIds }, isDeleted: { $ne: true } })
    .session(session)
    .populate({ path: "unit", strictPopulate: false });

  const unitMap = new Map(units.map((u) => [u._id.toString(), u]));
  const productMap = new Map(products.map((p) => [p._id.toString(), p]));

  // 1. Aggregation Pass
  for (const item of items) {
    const { product: productId, quantity, unit: unitId } = item;

    // Fetch unit from map
    const saleUnit = unitMap.get(unitId.toString());
    if (!saleUnit) {
      throw new ApiError(400, `Unit not found for product ${productId}`);
    }

    let currentTotal = productQuantities.get(productId.toString());
    if (!currentTotal) {
      currentTotal = { baseUnitRequests: [] };
      productQuantities.set(productId.toString(), currentTotal);
    }

    // Store instruction
    currentTotal.baseUnitRequests.push({
      quantity,
      conversionFactor: saleUnit.conversionFactor,
      unitType: saleUnit.type,
      unitId,
      unitName: saleUnit.name,
    });
  }

  // 2. Validation Pass
  for (const [productId, data] of productQuantities.entries()) {
    const sellingProduct = productMap.get(productId);

    if (!sellingProduct) {
      throw new ApiError(400, `Product not found: ${productId}`);
    }

    // --- Warehouse Consistency Check ---
    if (sellingProduct.warehouse.toString() !== warehouseId.toString()) {
      throw new ApiError(
        400,
        `Product '${sellingProduct.name}' does not belong to the selected warehouse.`
      );
    }

    let totalBaseUnitRequired = 0;

    for (const req of data.baseUnitRequests) {
      // Check Type Compatibility
      if (sellingProduct.unit.type !== req.unitType) {
        throw new ApiError(
          400,
          `Incompatible units for product '${sellingProduct.name}'. Product is in '${sellingProduct.unit.type}' but sale item is in '${req.unitType}'.`
        );
      }
      // totalBaseUnitRequired += req.quantity * req.conversionFactor;
      const reqTotal = mathUtil.mul(req.quantity, req.conversionFactor);
      totalBaseUnitRequired = mathUtil.add(totalBaseUnitRequired, reqTotal);
    }

    const productStockInBaseUnit = mathUtil.mul(sellingProduct.quantity, sellingProduct.unit.conversionFactor);

    if (productStockInBaseUnit < totalBaseUnitRequired) {
      // Calculate max qty in the *last requested unit* for better error message,
      // or just use base unit. Let's use the first requested unit's name for clarity if possible.
      const displayUnitName = data.baseUnitRequests[0].unitName;
      const displayConversion = data.baseUnitRequests[0].conversionFactor;

      throw new ApiError(
        400,
        `Not enough stock for product '${sellingProduct.name}'. Requested: ${(
          mathUtil.div(totalBaseUnitRequired, displayConversion)
        ).toFixed(2)} ${displayUnitName} (Available: ${(
          mathUtil.div(productStockInBaseUnit, displayConversion)
        ).toFixed(2)} ${displayUnitName})`
      );
    }

    // Calculate deduction in Product's Native Unit
    // const quantityToDeductFromProduct = totalBaseUnitRequired / sellingProduct.unit.conversionFactor;
    const quantityToDeductFromProduct = mathUtil.div(totalBaseUnitRequired, sellingProduct.unit.conversionFactor);
    deductions.push({ productId, quantityToDeductFromProduct });
  }

  return deductions;
};

/**
 * Checks if adding this sale exceeds the customer's credit limit
 */
exports.checkCustomerCreditLimit = async (
  customerId,
  saleFinancials,
  session,
) => {
  // saleFinancials: { totalAmount, costsTotal, chargesTotal, discount, totalPaid }
  const existingCustomer = await Customer.findOne({
    _id: customerId,
    isDeleted: { $ne: true },
  }).session(session);

  if (!existingCustomer) {
    throw new ApiError(400, "Customer not found");
  }

  const { totalAmount, costsTotal, chargesTotal, discount, totalPaid } =
    saleFinancials;

  // prospectiveTotal = totalAmount + costsTotal + chargesTotal - discount
  const subTotal = mathUtil.add(totalAmount, mathUtil.add(costsTotal, chargesTotal));
  const prospectiveTotal = mathUtil.sub(subTotal, discount);

  const newSaleDueAmount = mathUtil.sub(prospectiveTotal, totalPaid);

  // Only check if there is a due amount
  if (newSaleDueAmount > 0) {
    // Credit limit logic:
    // - null/undefined = credit limit feature DISABLED → no limit, skip check
    // - 0 = customer can NOT take any due at all
    // - number > 0 = that's the ceiling
    if (existingCustomer.creditLimit === null || existingCustomer.creditLimit === undefined) {
      // Credit limit disabled — allow unlimited due
      return existingCustomer;
    }

    const salesPipeline = [
      {
        $match: {
          "customer.customerId": existingCustomer._id,
          isDeleted: { $ne: true },
          paymentStatus: "Due payment",
        },
      },
      {
        $group: {
          _id: null,
          totalDue: {
            $sum: {
              $subtract: ["$totalAmountToBePaid", { $sum: "$payments.amount" }],
            },
          },
        },
      },
    ];

    const result = await Sales.aggregate(salesPipeline).session(session);
    const currentDues = result.length > 0 ? result[0].totalDue : 0;

    const totalOutstanding = mathUtil.add(currentDues, newSaleDueAmount);

    if (existingCustomer.creditLimit === 0) {
      throw new ApiError(
        409,
        `Cannot create sale with due amount. This customer's credit limit is set to 0 (no due allowed). The transaction requires a due of ${newSaleDueAmount}. Please collect full payment.`,
      );
    }

    if (totalOutstanding > existingCustomer.creditLimit) {
      throw new ApiError(
        409,
        `Cannot create sale. This transaction exceeds the customer's credit limit of ${existingCustomer.creditLimit}. Current outstanding due is ${currentDues}.`,
      );
    }
  }
  return existingCustomer;
};

/**
 * Calculates the difference between old and new items to determine stock adjustments.
 * Returns a list of actions: { productId, quantityChange, type: 'deduct' | 'restore' }
 * quantityChange is always positive in the product's native unit.
 */
/**
 * Calculates the difference between old and new items to determine stock adjustments.
 * Returns a list of actions: { productId, quantityChange, type: 'deduct' | 'restore' }
 * quantityChange is always positive in the product's native unit.
 */
exports.calculateStockDiff = async (oldItems, newItems, session) => {
  const stockActions = [];
  const productMap = new Map();

  // Collect all relevant IDs for batch fetching
  const productIds = new Set();
  const unitIds = new Set();

  oldItems.forEach((item) => {
    if (item.product)
      productIds.add(
        typeof item.product === "object" ? item.product._id : item.product
      );
    if (item.unit)
      unitIds.add(
        typeof item.unit === "object" ? item.unit._id : item.unit
      );
  });

  newItems.forEach((item) => {
    if (item.product) productIds.add(item.product);
    if (item.unit) unitIds.add(item.unit);
  });

  // Batch Fetch
  // Serialized Fetch
  const products = await Product.find({ _id: { $in: [...productIds] }, isDeleted: { $ne: true } })
    .session(session)
    .populate({ path: "unit", strictPopulate: false });
  const units = await Unit.find({ _id: { $in: [...unitIds] } }).session(session);

  const fetchedProductMap = new Map(products.map((p) => [p._id.toString(), p]));
  const fetchedUnitMap = new Map(units.map((u) => [u._id.toString(), u]));

  // 1. Map Old Items (Restore Logic)
  // We "have" this, so valid demand is negative (already taken)
  // Net Change approach:
  // productMap value will represent "Net Base Unit Change Required"

  for (const item of oldItems) {
    if (!item.product) continue;
    const productId =
      typeof item.product === "object"
        ? item.product._id.toString()
        : item.product.toString();
    const qty = item.quantity || 0;

    // Use fetched unit if available, otherwise rely on item.unit object if populated, else error/default
    let conversionFactor = 1;
    let unitIdStr = "";

    if (item.unit && typeof item.unit === "object") {
      unitIdStr = item.unit._id.toString();
      conversionFactor = item.unit.conversionFactor || 1;
    } else if (item.unit) {
      unitIdStr = item.unit.toString();
      const u = fetchedUnitMap.get(unitIdStr);
      if (u) conversionFactor = u.conversionFactor;
    }

    const baseQty = mathUtil.mul(qty, conversionFactor);
    const current = productMap.get(productId) || 0;
    productMap.set(productId, mathUtil.sub(current, baseQty));
  }

  for (const item of newItems) {
    if (!item.product) continue;
    const productId = item.product.toString();
    const qty = parseFloat(item.quantity) || 0;

    const unit = fetchedUnitMap.get(item.unit.toString());
    if (!unit)
      throw new ApiError(400, `Unit not found for product ${productId}`);

    const baseQty = mathUtil.mul(qty, unit.conversionFactor);

    const current = productMap.get(productId) || 0;
    productMap.set(productId, mathUtil.add(current, baseQty));
  }

  // Now process the map
  for (const [productId, netBaseQty] of productMap.entries()) {
    if (Math.abs(netBaseQty) < 0.0001) continue; // Floating point safety

    const product = fetchedProductMap.get(productId);
    if (!product) throw new ApiError(404, `Product not found: ${productId}`);

    // const nativeQtyChange = Math.abs(netBaseQty) / product.unit.conversionFactor;
    const nativeQtyChange = mathUtil.div(Math.abs(netBaseQty), product.unit.conversionFactor);

    if (netBaseQty > 0) {
      // Need MORE -> Deduct
      // Verify Stock Availability
      // if (product.quantity < nativeQtyChange - 0.0001) {
      if (mathUtil.sub(product.quantity, nativeQtyChange) < -0.0001) {
        // Tiny tolerance for float comparison
        throw new ApiError(
          400,
          `Insufficient stock for '${product.name}'. Required additional: ${nativeQtyChange.toFixed(
            3
          )} ${product.unit.name}, Available: ${product.quantity.toFixed(3)} ${product.unit.name
          }`
        );
      }
      stockActions.push({
        productId,
        quantity: nativeQtyChange,
        type: "deduct",
      });
    } else {
      // Need LESS -> Restore
      stockActions.push({
        productId,
        quantity: nativeQtyChange,
        type: "restore",
      });
    }
  }

  return stockActions;
};

/**
 * Applies the calculated stock actions using bulkWrite for performance.
 */
exports.applyStockDiff = async (actions, session) => {
  if (actions.length === 0) return;

  const operations = actions.map((action) => {
    const adjustment =
      action.type === "deduct" ? -action.quantity : action.quantity;
    return {
      updateOne: {
        filter: { _id: action.productId },
        update: { $inc: { quantity: adjustment } },
      },
    };
  });

  await Product.bulkWrite(operations, { session });
};

/**
 * Reconciles the financial state of a sale.
 * Calculates totalPaid, balanceDue, overPayment, and updates paymentStatus.
 * This function is the Single Source of Truth for a sale's financial state.
 */
exports.reconcileSaleFinancials = async (saleId, session) => {
  const sale = await Sales.findById(saleId).session(session);
  if (!sale) throw new ApiError(404, "Sale not found for reconciliation");

  // 1. Calculate Totals
  // totalAmountToBePaid is already calculated by pre-save hook on the model,
  // but if we are calling this AFTER modification, we should ensure it's up to date.
  // Ideally, the pre-save hook handles the "ToBePaid" logic based on items/costs.
  // We focus on PAYMENTS and STATUS here.

  // const totalPaid = sale.payments.reduce((sum, p) => sum + (p.amount || 0), 0);
  const totalPaid = sale.payments.reduce((sum, p) => p.isReversed ? sum : mathUtil.add(sum, p.amount || 0), 0);
  const totalDue = sale.totalAmountToBePaid;

  let balanceDue = 0;
  let overPayment = 0;

  if (totalPaid >= totalDue) {
    // overPayment = totalPaid - totalDue;
    overPayment = mathUtil.sub(totalPaid, totalDue);
    balanceDue = 0;
  } else {
    // balanceDue = totalDue - totalPaid;
    balanceDue = mathUtil.sub(totalDue, totalPaid);
    overPayment = 0;
  }

  // 2. Determine Status
  let status = "Due";
  if (sale.invoiceStatus === "Cancelled") {
    status = "N/A";
  } else if (balanceDue <= 0 && overPayment >= 0) {
    // Fully paid or overpaid
    status = overPayment > 0 ? "Overpaid" : "Paid";
  } else if (totalPaid > 0) {
    status = "Partial";
  } else {
    status = "Due";
  }

  // 3. Update Document
  sale.totalPaid = totalPaid;
  sale.balanceDue = balanceDue;
  sale.overPayment = overPayment;
  sale.paymentStatus = status;

  await sale.save({ session, validateBeforeSave: false }); // Skip validation to avoid infinite loops if hooks exist
  return sale;
};
/**
 * Reconciles costs during a sale update.
 * Identifies added, removed, or modified costs and updates accounts/transactions/DailyCash accordingly.
 */
exports.reconcileCosts = async (
  oldCosts = [],
  newCosts = [],
  sale,
  session,
  businessTimezone
) => {
  // Helper to create a unique key for a cost to track identity
  // We assume if name AND amount AND date AND payment method match, it's the "same" cost contextually,
  // BUT in an edit, we might change amount.
  // Best approach: "Diff" by index is risky if array is reordered.
  // "Diff" by Name is possible if names are unique.
  // Mongoose Subdocuments have _id. We should rely on _id if available.

  const oldMap = new Map();
  oldCosts.forEach(c => {
    if (c._id) oldMap.set(c._id.toString(), c);
  });

  const processedIds = new Set();
  const today = startOfDay(now(), businessTimezone);

  // 1. Process New/Updated Costs
  for (const newCost of newCosts) {
    if (newCost._id && oldMap.has(newCost._id.toString())) {
      // Update Scenario
      const oldCost = oldMap.get(newCost._id.toString());
      processedIds.add(newCost._id.toString());

      // Check if critical fields changed
      const amountChanged = newCost.amount !== oldCost.amount;
      const accountChanged = newCost.accountId?.toString() !== oldCost.accountId?.toString();
      const methodChanged = newCost.paymentMethod !== oldCost.paymentMethod;

      if (amountChanged || accountChanged || methodChanged) {
        // REVERSE Old -> APPLY New
        // A. Reverse Old
        await reverseCostTransaction(oldCost, sale, session, businessTimezone);
        // B. Apply New
        await applyCostTransaction(newCost, sale, session, businessTimezone);
      }
    } else {
      // New Cost Scenario (No _id or not in old map)
      await applyCostTransaction(newCost, sale, session, businessTimezone);
    }
  }

  // 2. Process Removed Costs
  for (const [id, oldCost] of oldMap.entries()) {
    if (!processedIds.has(id)) {
      await reverseCostTransaction(oldCost, sale, session, businessTimezone);
    }
  }
};

async function reverseCostTransaction(cost, sale, session, businessTimezone) {
  if (!cost.accountId) return;

  const account = await Account.findById(cost.accountId).session(session);
  if (!account) throw new ApiError(404, `Account not found for cost reversal: ${cost.name}`);

  // DailyCash Check
  const date = startOfDay(new Date(cost.date || sale.saleDate), businessTimezone);
  const dailyCash = await DailyCash.findOne({ date }).session(session);
  if (dailyCash && dailyCash.status === "Closed") {
    throw new ApiError(400, `Cannot update cost '${cost.name}' because Daily Cash for ${date.toDateString()} is closed.`);
  }

  // Restore Balance (Expense Reversal = Income/Add back)
  // account.balance += cost.amount;
  account.balance = mathUtil.add(account.balance, cost.amount);
  await account.save({ session });

  // Record Reversal Transaction
  await Transaction.create([{
    accountId: cost.accountId,
    date: now(),
    description: `Correction: Reversal of cost '${cost.name}' for Sale ${sale.saleId}`,
    transactionType: "Income", // technically reversing an expense
    amount: cost.amount,
    name: `Rev: ${cost.name}`,
    source: "Auto",
    category: "Cost Reversal",
    reference: sale._id,
    referenceModel: "Sale"
  }], { session });
}

async function applyCostTransaction(cost, sale, session, businessTimezone) {
  if (!cost.accountId) return;

  const account = await Account.findById(cost.accountId).session(session);
  if (!account) throw new ApiError(404, `Account not found for cost: ${cost.name}`);

  // Validate Account Type
  const expectedType = cost.paymentMethod === "Mobile Banking" ? "Mobile Banking" : cost.paymentMethod;
  if (account.accountType !== expectedType) {
    throw new ApiError(400, `Cost '${cost.name}' requires ${expectedType} account, got ${account.accountType}.`);
  }

  // DailyCash Check
  const date = startOfDay(new Date(cost.date || sale.saleDate), businessTimezone);
  const dailyCash = await DailyCash.findOne({ date }).session(session);
  if (dailyCash && dailyCash.status === "Closed") {
    throw new ApiError(400, `Cannot add cost '${cost.name}' because Daily Cash for ${date.toDateString()} is closed.`);
  }

  // Deduct Balance
  // account.balance -= cost.amount;
  account.balance = mathUtil.sub(account.balance, cost.amount);
  await account.save({ session });

  // Record Transaction
  await Transaction.create([{
    accountId: cost.accountId,
    date: cost.date || sale.saleDate,
    description: `Cost for sale ${sale.saleId}: ${cost.name} via ${cost.paymentMethod} Account: ${formatAccountLabel(account)}.`,
    transactionType: "Expense",
    amount: cost.amount,
    name: `Sale Cost - ${cost.name}`,
    source: "Auto",
    category: "Sales Expense",
    paymentMethod: cost.paymentMethod,
    reference: sale._id,
    referenceModel: "Sale",
    miscReference: {
      saleId: sale.saleId,
      costName: cost.name,
      costAmount: cost.amount,
    },
  }], { session });
}

/**
 * Reconciles payments during a sale update.
 * Identifies added and removed payments and processes financial side-effects
 * (Account balance updates, Transaction records, DailyCash checks, Customer Credit).
 *
 * Modeled after the existing reconcileCosts pattern.
 */

exports.reconcilePayments = async (
  oldPayments = [],
  newPayments = [],
  sale,
  session,
  businessTimezone
) => {
  // Build a map of old payments by _id for efficient lookup
  const oldMap = new Map();
  oldPayments.forEach(p => {
    if (p._id) oldMap.set(p._id.toString(), p);
  });

  const processedIds = new Set();

  // 1. Process New/Updated Payments
  for (const newPayment of newPayments) {
    if (newPayment._id && oldMap.has(newPayment._id.toString())) {
      // Existing payment — mark as processed (no changes needed since payments are immutable once created)
      processedIds.add(newPayment._id.toString());
      // Note: We do NOT support modifying an existing payment's amount/method.
      // If needed, the user should remove and re-add the payment.
    } else {
      // NEW payment — process financial side effects
      await applyPaymentTransaction(newPayment, sale, session, businessTimezone);
    }
  }

  // 2. Process Removed Payments (old payments not found in new set)
  for (const [id, oldPayment] of oldMap.entries()) {
    if (!processedIds.has(id)) {
      await reversePaymentTransaction(oldPayment, sale, session, businessTimezone);
    }
  }
};

/**
 * Applies financial side effects for a new payment.
 * Creates Transaction record, updates Account balance, checks DailyCash, handles Customer Credit.
 * Mirrors the logic in createSale (lines 229-338) and addPartialPayment (lines 1564-1669).
 */
async function applyPaymentTransaction(payment, sale, session, businessTimezone) {
  if (!payment.amount || payment.amount <= 0) return;

  if (payment.method === "Customer Credit") {
    // Handle Customer Credit Payment
    if (!sale.customer?.customerId) {
      throw new ApiError(400, "Guest/Manual customers cannot pay with Customer Credit.");
    }

    // Atomic deduction with balance guard
    const updatedCustomer = await Customer.findOneAndUpdate(
      {
        _id: sale.customer.customerId,
        creditBalance: { $gte: payment.amount },
        isDeleted: { $ne: true },
      },
      { $inc: { creditBalance: -payment.amount } },
      { session, new: true }
    );

    if (!updatedCustomer) {
      const customer = await Customer.findOne({
        _id: sale.customer.customerId,
        isDeleted: { $ne: true },
      }).session(session);
      throw new ApiError(
        400,
        `Insufficient credit balance. Available: ${customer?.creditBalance || 0}, Required: ${payment.amount}`
      );
    }

    // Record Credit History (Debit)
    await CreditHistory.create(
      [
        {
          customer: sale.customer.customerId,
          amount: payment.amount,
          type: "Debit",
          reason: "Purchase",
          reference: sale._id,
          referenceModel: "Sale",
          description: `Payment for Sale ID: ${sale.saleId} (added during edit)`,
        },
      ],
      { session }
    );
  } else if (["Bank", "Mobile Banking", "Cash"].includes(payment.method)) {
    // Handle Real Money Payment
    if (!payment.accountId) {
      throw new ApiError(400, `Account ID is required for ${payment.method} payment.`);
    }

    const account = await Account.findById(payment.accountId).session(session);
    if (!account) {
      throw new ApiError(404, `Account not found for payment.`);
    }

    // Validate account type
    const expectedAccountType =
      payment.method === "Mobile Banking" ? "Mobile Banking" : payment.method;
    if (account.accountType !== expectedAccountType) {
      throw new ApiError(
        400,
        `Payment method '${payment.method}' requires a '${expectedAccountType}' account, but a '${account.accountType}' account was provided.`
      );
    }

    // DailyCash Gatekeeper Check
    const paymentDate = startOfDay(new Date(payment.date), businessTimezone);
    const dailyCash = await DailyCash.findOne({ date: paymentDate }).session(session);
    if (!dailyCash || dailyCash.status === "Closed") {
      throw new ApiError(
        400,
        `Daily cash is closed (or not opened) for ${paymentDate.toDateString()}. Cannot record payment.`
      );
    }

    // Increase account balance
    account.balance = mathUtil.add(account.balance, payment.amount);
    await account.save({ session });

    // Create Transaction record
    await Transaction.create(
      [
        {
          accountId: account._id,
          date: payment.date,
          description: `Payment received for Sale ID: ${sale.saleId} from ${sale.customer?.name || "Guest"} via ${payment.method} Account: ${formatAccountLabel(account)}.`,
          transactionType: "Income",
          amount: payment.amount,
          name: "Sales Payment",
          source: "Auto",
          category: "Sales",
          paymentMethod: payment.method,
          reference: sale._id,
          referenceModel: "Sale",
          miscReference: {
            saleId: sale.saleId,
            customerName: sale.customer?.name,
            paymentAmount: payment.amount,
            paymentMethod: payment.method,
          },
        },
      ],
      { session }
    );
  }
}

/**
 * Reverses financial side effects for a removed payment.
 * Creates reversal Transaction record, updates Account balance, refunds Customer Credit.
 * Mirrors the logic in deleteSale (lines 1131-1199).
 */
async function reversePaymentTransaction(payment, sale, session, businessTimezone) {
  if (!payment.amount || payment.amount <= 0) return;

  if (payment.method === "Customer Credit") {
    // Refund Customer Credit
    if (sale.customer?.customerId) {
      await Customer.findByIdAndUpdate(
        sale.customer.customerId,
        { $inc: { creditBalance: payment.amount } },
        { session }
      );

      await CreditHistory.create(
        [
          {
            customer: sale.customer.customerId,
            amount: payment.amount,
            type: "Credit",
            reason: "Payment Removed",
            reference: sale._id,
            referenceModel: "Sale",
            description: `Reversal of payment for Sale ID: ${sale.saleId} (payment removed during edit)`,
          },
        ],
        { session }
      );
    }
  } else if (["Bank", "Mobile Banking", "Cash"].includes(payment.method)) {
    if (!payment.accountId) return;

    const account = await Account.findById(payment.accountId).session(session);
    if (!account) {
      throw new ApiError(
        400,
        `Cannot reverse payment because the associated account (ID: ${payment.accountId}) is missing. Please restore the account first.`
      );
    }

    // DailyCash Check
    const date = startOfDay(new Date(payment.date || sale.saleDate), businessTimezone);
    const dailyCash = await DailyCash.findOne({ date }).session(session);
    if (dailyCash && dailyCash.status === "Closed") {
      throw new ApiError(
        400,
        `Cannot reverse payment because Daily Cash for ${date.toDateString()} is closed.`
      );
    }

    // Decrease account balance (reverse the income)
    account.balance = mathUtil.sub(account.balance, payment.amount);
    await account.save({ session });

    // Create reversal Transaction
    await Transaction.create(
      [
        {
          accountId: payment.accountId,
          date: now(),
          description: `Reversal: Payment removed for Sale ID: ${sale.saleId} (Customer: ${sale.customer?.name || "Guest"}) via ${payment.method} Account: ${formatAccountLabel(account)}.`,
          transactionType: "Expense",
          amount: payment.amount,
          name: "Sales Payment Reversal",
          source: "Auto",
          category: "Sales Reversal",
          paymentMethod: payment.method,
          reference: sale._id,
          referenceModel: "Sale",
          miscReference: {
            saleId: sale.saleId,
            customerName: sale.customer?.name,
            paymentAmount: payment.amount,
            paymentMethod: payment.method,
          },
        },
      ],
      { session }
    );
  }
}
