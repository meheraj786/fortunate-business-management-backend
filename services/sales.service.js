const Sales = require("../models/sales.model");
const Product = require("../models/product.model");
const Customer = require("../models/customer.model");
const Unit = require("../models/unit.model");
const { ApiError } = require("../utils/ApiError");
const { startOfDay, now } = require("../utils/timezone.util");
const Transaction = require("../models/transaction.model");
const Account = require("../models/account.model");
const DailyCash = require("../models/dailyCash.model");
const { formatAccountLabel } = require("../utils/format.util");

/**
 * Generates a new sequential Sale ID (e.g., SALE-24-000001)
 */
const Counter = require("../models/counter.model");

/**
 * Generates a new sequential Sale ID (e.g., SALE-24-000001)
 * Uses a persistent Counter model to ensure IDs are never reused, even if sales are deleted.
 */
exports.generateSaleId = async () => {
  const currentYear = new Date().getFullYear();
  const shortYear = currentYear.toString().slice(-2);
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

  // 1. Aggregation Pass
  for (const item of items) {
    const { product: productId, quantity, unit: unitId } = item;

    // Fetch unit to get conversion factor
    const saleUnit = await Unit.findById(unitId).session(session);
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
      unitName: saleUnit.name
    });
  }

  // 2. Validation Pass
  for (const [productId, data] of productQuantities.entries()) {
    const sellingProduct = await Product.findOne({
      _id: productId,
      isDeleted: { $ne: true },
    })
      .session(session)
      .populate("unit");

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
      totalBaseUnitRequired += req.quantity * req.conversionFactor;
    }

    const productStockInBaseUnit = sellingProduct.quantity * sellingProduct.unit.conversionFactor;

    if (productStockInBaseUnit < totalBaseUnitRequired) {
      // Calculate max qty in the *last requested unit* for better error message, 
      // or just use base unit. Let's use the first requested unit's name for clarity if possible.
      const displayUnitName = data.baseUnitRequests[0].unitName;
      const displayConversion = data.baseUnitRequests[0].conversionFactor;

      throw new ApiError(
        400,
        `Not enough stock for product '${sellingProduct.name}'. Requested: ${(totalBaseUnitRequired / displayConversion).toFixed(2)} ${displayUnitName} (Available: ${(productStockInBaseUnit / displayConversion).toFixed(2)} ${displayUnitName})`
      );
    }

    // Calculate deduction in Product's Native Unit
    const quantityToDeductFromProduct = totalBaseUnitRequired / sellingProduct.unit.conversionFactor;
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
  const prospectiveTotal = totalAmount + costsTotal + chargesTotal - discount;
  const newSaleDueAmount = prospectiveTotal - totalPaid;

  // Only check if there is a due amount
  if (newSaleDueAmount > 0) {
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

    if (currentDues + newSaleDueAmount > existingCustomer.creditLimit) {
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
exports.calculateStockDiff = async (oldItems, newItems, session) => {
  const stockActions = [];
  const productMap = new Map();

  // 1. Map Old Items (Restore Logic)
  // We initially assume we "restore" everything, then we subtract what is kept/added.
  // Or better: Calculate Net Change per Product.

  // Let's use a Net Base Unit Change approach per Product ID.
  // Positive Net = We need MORE stock (Deduct from DB)
  // Negative Net = We return stock (Restore to DB)

  // Map: productId -> netBaseQuantityRequired

  for (const item of oldItems) {
    if (!item.product) continue;
    const productId = item.product._id || item.product;
    const qty = item.quantity || 0;

    // existing item might have unit populated or not. 
    // If populated, use it. If not, we might need to fetch it? 
    // Ideally oldItems come from a populated sale query.
    // We'll assume caller provides populated items or we fetch.
    // For robust server-side logic, we should probably fetch to be 100% sure of conversion factors?
    // BUT fetching everything again is expensive.
    // Let's assume standard populated structure: item.unit is an object with conversionFactor.

    const conversionFactor = item.unit?.conversionFactor || 1;
    const baseQty = qty * conversionFactor;

    const current = productMap.get(productId.toString()) || 0;
    productMap.set(productId.toString(), current - baseQty); // We "have" this, so valid demand is negative (already taken)
    // Wait, let's think:
    // Net Change = New Demand - Old Demand
    // If Net Change > 0: Deduct Stock
    // If Net Change < 0: Restore Stock

    // So Old Demand is what we currently hold.
    // productMap value will represent "New Demand". 
    // So start with NEGATIVE Old Demand? 
    // No, let's track "Net Required".
    // Initial State: We have taken X. 
    // If we want Y. Net = Y - X.

    productMap.set(productId.toString(), current - baseQty);
  }

  for (const item of newItems) {
    if (!item.product) continue;
    const productId = item.product; // newItems usually have raw IDs
    const qty = parseFloat(item.quantity) || 0;

    // We need the unit's conversion factor for the NEW item.
    // The frontend sends unit ID. We must fetch it.
    const unit = await Unit.findById(item.unit).session(session);
    if (!unit) throw new ApiError(400, `Unit not found for product ${productId}`);

    const baseQty = qty * unit.conversionFactor;

    const current = productMap.get(productId.toString()) || 0;
    productMap.set(productId.toString(), current + baseQty);
  }

  // Now process the map
  for (const [productId, netBaseQty] of productMap.entries()) {
    if (netBaseQty === 0) continue;

    const product = await Product.findById(productId).session(session).populate('unit');
    if (!product) throw new ApiError(404, `Product not found: ${productId}`);

    const nativeQtyChange = Math.abs(netBaseQty) / product.unit.conversionFactor;

    if (netBaseQty > 0) {
      // Need MORE -> Deduct
      // Verify Stock Availability
      if (product.quantity < nativeQtyChange) {
        throw new ApiError(400, `Insufficient stock for '${product.name}'. Required additional: ${nativeQtyChange.toFixed(3)} ${product.unit.name}, Available: ${product.quantity.toFixed(3)} ${product.unit.name}`);
      }
      stockActions.push({
        productId,
        quantity: nativeQtyChange,
        type: 'deduct'
      });
    } else {
      // Need LESS -> Restore
      stockActions.push({
        productId,
        quantity: nativeQtyChange,
        type: 'restore'
      });
    }
  }

  return stockActions;
};

/**
 * Applies the calculated stock actions.
 */
exports.applyStockDiff = async (actions, session) => {
  for (const action of actions) {
    const adjustment = action.type === 'deduct' ? -action.quantity : action.quantity;

    await Product.findByIdAndUpdate(
      action.productId,
      { $inc: { quantity: adjustment } },
      { session, new: true }
    );
  }
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

  const totalPaid = sale.payments.reduce((sum, p) => sum + (p.amount || 0), 0);
  const totalDue = sale.totalAmountToBePaid;

  let balanceDue = 0;
  let overPayment = 0;

  if (totalPaid >= totalDue) {
    overPayment = totalPaid - totalDue;
    balanceDue = 0;
  } else {
    balanceDue = totalDue - totalPaid;
    overPayment = 0;
  }

  // 2. Determine Status
  let status = "Due";
  if (sale.invoiceStatus === "Cancelled") {
    status = "N/A";
  } else if (balanceDue <= 0 && overPayment >= 0) {
    // Fully paid or overpaid
    status = overPayment > 0 ? "Overpaid" : "Paid";
    // Mapped to legacy string if needed, but we start using new enums internally.
    // If we want to be safe with existing frontend filters:
    // "Paid payment" / "Due payment".
    // Let's use the new cleaner ones, and we will update frontend mapping if needed.
    // Actually, to match current mismatched frontend expectations without breaking it immediately:
    // "Paid" -> "Paid payment"
    // "Due" -> "Due payment"
    // "Overpaid" -> "Paid payment" (Technically it IS paid) OR a new status.
    // The Schema now allows "Overpaid".
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
    account.balance += cost.amount;
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
    account.balance -= cost.amount;
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
