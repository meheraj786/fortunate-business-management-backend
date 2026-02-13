const Sales = require("../models/sales.model");
const Product = require("../models/product.model");
const Customer = require("../models/customer.model");
const Unit = require("../models/unit.model");
const { ApiError } = require("../utils/ApiError");
const logger = require("../utils/logger");
const { ApiResponse } = require("../utils/ApiResponse");
const Account = require("../models/account.model");
const DailyCash = require("../models/dailyCash.model");
const mongoose = require("mongoose");
const Transaction = require("../models/transaction.model");
const Trash = require("../models/trash.model");
const { startOfDay, endOfDay, now } = require("../utils/timezone.util");
const SalesService = require("../services/sales.service");
const { formatAccountLabel } = require("../utils/format.util");
const CreditHistory = require("../models/creditHistory.model");

async function createSale(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    // Generate saleId using service
    const newSaleId = await SalesService.generateSaleId();
    req.body.saleId = newSaleId;

    const {
      items = [], // Array of { product, quantity, unit, pricePerUnit }
      customer: customerInfo, // { customerId, name, phone, address }
      warehouse,
      category, // Main category for the sale
      costs = [],
      charges = [],
      discount = 0,
      invoiceStatus,
      payments: originalPayments = [],
      notes,
      saleDate,
    } = req.body;

    // Validate Sale Date
    SalesService.validateSaleDate(saleDate, req.businessTimezone);

    // Manual Customer Validation
    if (!customerInfo.customerId && invoiceStatus !== "Invoiced") {
      throw new ApiError(
        400,
        "Guest/Manual sales must be fully invoiced immediately.",
      );
    }

    const validationErrors = [];
    if (!items || items.length === 0) {
      validationErrors.push({
        field: "items",
        message: "At least one item is required",
      });
    }

    // Validate individual items
    items.forEach((item, index) => {
      if (!item.product) validationErrors.push({ field: `items[${index}].product`, message: "Product is required" });
      if (!item.quantity) validationErrors.push({ field: `items[${index}].quantity`, message: "Quantity is required" });
      if (!item.unit) validationErrors.push({ field: `items[${index}].unit`, message: "Unit is required" });
      if (!item.pricePerUnit && item.pricePerUnit !== 0) validationErrors.push({ field: `items[${index}].pricePerUnit`, message: "Price is required" });
    });

    if (!customerInfo || !customerInfo.name)
      validationErrors.push({
        field: "customer.name",
        message: "Customer name is required",
      });
    if (!warehouse)
      validationErrors.push({
        field: "warehouse",
        message: "Warehouse is required",
      });
    /* Category is now optional for multi-item sales
    if (!category && !req.body.category) {
       validationErrors.push({
        field: "category",
        message: "Category is required",
      });
    } 
    */

    if (validationErrors.length > 0) {
      throw new ApiError(400, validationErrors[0].message, validationErrors);
    }

    // Validate Stock logic utilizing service for ALL items
    // This returns deductions needed: [{ productId, quantityToDeductFromProduct }]
    const stockDeductions = await SalesService.validateStockForItems(items, warehouse, session);

    const finalCustomerInfo = {
      name: customerInfo.name,
      phone: customerInfo.phone,
      address: customerInfo.address,
      customerId: null,
    };

    // Transform payments
    const transformedPayments = originalPayments.map((p) => ({
      amount: p.amount,
      date: p.date,
      method: p.method,
      accountId: p.account || p.accountId,
    }));

    // Calculate Total Amount from items
    const totalAmount = Math.round(items.reduce((sum, item) => sum + (item.quantity * item.pricePerUnit), 0) * 100) / 100;

    // Prepare items with totals for saving
    const saleItems = items.map(item => ({
      ...item,
      total: item.quantity * item.pricePerUnit
    }));

    // Credit Limit Check
    if (customerInfo.customerId) {
      const costsTotal = costs.reduce((acc, cost) => acc + cost.amount, 0);
      const chargesTotal = charges.reduce(
        (acc, charge) => acc + charge.amount,
        0,
      );
      // totalAmount calculated above
      const totalPaidInThisTransaction = transformedPayments.reduce(
        (acc, p) => acc + p.amount,
        0,
      );

      const existingCustomer = await SalesService.checkCustomerCreditLimit(
        customerInfo.customerId,
        {
          totalAmount,
          costsTotal,
          chargesTotal,
          discount,
          totalPaid: totalPaidInThisTransaction,
        },
        session,
      );

      finalCustomerInfo.customerId = existingCustomer._id;
      finalCustomerInfo.name = existingCustomer.name;
      finalCustomerInfo.phone = existingCustomer.phone;
      finalCustomerInfo.address = existingCustomer.location;
    }

    const sale = new Sales({
      saleId: newSaleId,
      items: saleItems, // New Array
      customer: finalCustomerInfo,
      warehouse,
      category,
      // Removed single product fields
      totalAmount, // Explicitly set, though pre-save hook also calculates it
      costs,
      charges,
      discount,
      invoiceStatus,
      payments: transformedPayments,
      notes,
      saleDate,
      createdBy: req.user?._id || null,
    });

    // Trigger validation to calculate totalAmountToBePaid via pre-validate hook
    await sale.validate();

    if (sale.totalAmountToBePaid < 0) {
      throw new ApiError(400, "Total amount to be paid cannot be negative.");
    }

    // --- Optimization: Pre-fetch Accounts and DailyCash ---
    // Collect Account IDs
    const accountIds = new Set();
    transformedPayments.forEach((p) => {
      if (p.accountId) accountIds.add(p.accountId);
    });
    costs.forEach((c) => {
      if (c.accountId) accountIds.add(c.accountId);
    });

    // Collect Dates for DailyCash
    const dateStrings = new Set();
    transformedPayments.forEach((p) => {
      if (p.date)
        dateStrings.add(
          startOfDay(new Date(p.date), req.businessTimezone).toISOString()
        );
    });
    if (saleDate)
      dateStrings.add(
        startOfDay(new Date(saleDate), req.businessTimezone).toISOString()
      );
    costs.forEach((c) => {
      // costs usually follow saleDate, but if they had a specific date:
      const d = c.date || saleDate;
      dateStrings.add(startOfDay(new Date(d), req.businessTimezone).toISOString());
    });

    const [accounts, dailyCashEntries] = await Promise.all([
      Account.find({ _id: { $in: [...accountIds] } }).session(session),
      DailyCash.find({
        date: { $in: [...dateStrings] },
      }).select("date status").session(session).lean(),
    ]);

    const accountMap = new Map(accounts.map((a) => [a._id.toString(), a]));
    // Map ISO string to status
    const dailyCashMap = new Map(
      dailyCashEntries.map((dc) => [dc.date.toISOString(), dc.status])
    );

    // Helper to check DailyCash
    const checkDailyCash = (dateInput) => {
      const normalizedDate = startOfDay(
        new Date(dateInput),
        req.businessTimezone
      );
      const iso = normalizedDate.toISOString();
      // If no entry found, it means it's not "Closed" (implicitly Open or not created yet).
      // Logic in loop was: if (!dailyCash || dailyCash.status === "Closed") throw...
      // Wait, original logic: if (!dailyCash || dailyCash.status === "Closed")
      // This implies we MUST have a dailyCash entry and it must NOT be Closed.
      // So if it's missing, it's an error?
      // "Daily cash is closed for ... Cannot record payment."
      // Yes, gatekeeper often requires an Open slip.
      const status = dailyCashMap.get(iso);
      if (!status || status === "Closed") {
        throw new ApiError(
          400,
          `Daily cash is closed (or not opened) for ${normalizedDate.toDateString()}.`
        );
      }
    };

    // Handle payments and update account balances
    let totalPaidInThisTransaction = 0;

    for (const payment of transformedPayments) {
      totalPaidInThisTransaction += payment.amount;

      if (payment.method === "Customer Credit") {
        // Handle Customer Credit Payment
        if (!finalCustomerInfo.customerId) {
          throw new ApiError(
            400,
            "Guest/Manual customers cannot pay with Customer Credit.",
          );
        }

        // Atomic deduction with balance guard — prevents race conditions
        const updatedCustomer = await Customer.findOneAndUpdate(
          {
            _id: finalCustomerInfo.customerId,
            creditBalance: { $gte: payment.amount },
            isDeleted: { $ne: true },
          },
          { $inc: { creditBalance: -payment.amount } },
          { session, new: true },
        );

        if (!updatedCustomer) {
          const customer = await Customer.findOne({
            _id: finalCustomerInfo.customerId,
            isDeleted: { $ne: true },
          }).session(session);
          throw new ApiError(
            400,
            `Insufficient credit balance. Available: ${customer?.creditBalance || 0}, Required: ${payment.amount}`,
          );
        }

        // Record Credit History (Debit)
        await CreditHistory.create(
          [
            {
              customer: finalCustomerInfo.customerId,
              amount: payment.amount,
              type: "Debit",
              reason: "Purchase",
              reference: sale._id,
              referenceModel: "Sale",
              description: `Payment for Sale ID: ${sale.saleId}`,
              createdBy: req.user?._id,
            },
          ],
          { session },
        );
      } else if (
        ["Bank", "Mobile Banking", "Cash"].includes(payment.method)
      ) {
        // Handle Real Money Payment (Cash/Bank)
        if (!payment.accountId) {
          throw new ApiError(
            400,
            `Account ID is required for ${payment.method} payment.`,
          );
        }

        const account = accountMap.get(payment.accountId.toString());
        if (!account) {
          throw new ApiError(404, `Account not found for payment.`);
        }

        // Validate account type
        const expectedAccountType =
          payment.method === "Mobile Banking"
            ? "Mobile Banking"
            : payment.method;
        if (account.accountType !== expectedAccountType) {
          throw new ApiError(
            400,
            `Payment method '${payment.method}' requires a '${expectedAccountType}' account, but a '${account.accountType}' account was provided.`,
          );
        }

        // Increase account balance
        account.balance += payment.amount;
        await account.save({ session });

        // DailyCash Gatekeeper Check
        checkDailyCash(payment.date);

        await Transaction.create(
          [
            {
              accountId: account._id,
              date: payment.date,
              description: `Payment received for Sale ID: ${req.body.saleId} from ${finalCustomerInfo.name} via ${payment.method} Account: ${formatAccountLabel(account)}.`,
              transactionType: "Income",
              amount: payment.amount,
              name: "Sales Payment",
              source: "Auto",
              category: "Sales",
              paymentMethod: payment.method,
              reference: sale._id,
              referenceModel: "Sale",
              miscReference: {
                saleId: req.body.saleId,
                customerName: finalCustomerInfo.name,
                paymentAmount: payment.amount,
                paymentMethod: payment.method,
              },
            },
          ],
          { session },
        );
      }
    }

    await sale.save({ session });

    // Create expense transactions for each cost associated with the sale
    for (const cost of sale.costs) {
      if (cost.accountId) {
        const costAccount = accountMap.get(cost.accountId.toString());
        if (!costAccount) {
          throw new ApiError(404, `Account for cost '${cost.name}' not found.`);
        }

        // Validate that the account type matches the payment method for the cost
        const expectedAccountType =
          cost.paymentMethod === "Mobile Banking"
            ? "Mobile Banking"
            : cost.paymentMethod;
        if (costAccount.accountType !== expectedAccountType) {
          throw new ApiError(
            400,
            `For cost '${cost.name}', payment method '${cost.paymentMethod}' requires a '${expectedAccountType}' account, but a '${costAccount.accountType}' account was provided.`,
          );
        }

        // DailyCash check for the cost transaction date
        checkDailyCash(cost.date || sale.saleDate);

        costAccount.balance -= cost.amount;
        await costAccount.save({ session });

        await Transaction.create(
          [
            {
              accountId: cost.accountId,
              date: sale.saleDate,
              description: `Cost for sale ${sale.saleId}: ${cost.name} via ${cost.paymentMethod} Account: ${formatAccountLabel(costAccount)}.`,
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
            },
          ],
          { session },
        );
      }
    }

    if (invoiceStatus === "Invoiced") {
      // Apply Stock Deductions for ALL items
      for (const deduction of stockDeductions) {
        await Product.findOneAndUpdate(
          { _id: deduction.productId, isDeleted: { $ne: true } },
          { $inc: { quantity: -deduction.quantityToDeductFromProduct } },
          { new: true, session },
        );
      }
    }

    if (finalCustomerInfo.customerId) {
      await Customer.findOneAndUpdate(
        { _id: finalCustomerInfo.customerId, isDeleted: { $ne: true } },
        {
          $push: { transactions: sale._id },
        },
        { session },
      );
    }

    // --- Strict Payment Logic ---
    const totalPaid = Math.round(sale.payments.reduce((acc, p) => acc + p.amount, 0) * 100) / 100;

    if (totalPaid > sale.totalAmountToBePaid) {
      throw new ApiError(
        400,
        `Payment amount (${totalPaid}) cannot exceed the total amount to be paid (${sale.totalAmountToBePaid}).`,
      );
    }

    await SalesService.reconcileSaleFinancials(sale._id, session);

    await session.commitTransaction();
    session.endSession();

    return res
      .status(201)
      .json(new ApiResponse(201, sale, "Sale created successfully"));
  } catch (error) {
    await session.abortTransaction();
    session.endSession();

    // If the error is already one of our custom ApiErrors, just pass it along.
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A sale with the same ${field} '${value}' already exists.`,
        ),
      ); // Specific message for sales
    }
    // Handle Mongoose validation errors
    if (error.name === "ValidationError") {
      const firstErrorField = Object.keys(error.errors)[0];
      let userFriendlyMessage = "Validation failed.";

      if (firstErrorField) {
        userFriendlyMessage = `The field ${firstErrorField} is required.`;
      }
      return next(new ApiError(400, userFriendlyMessage, error.errors));
    }
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
}

async function getAllSales(_, res, next) {
  try {
    const sales = await Sales.aggregate([
      {
        $match: {
          isDeleted: { $ne: true },
        },
      },
      // Populate customer.customerId
      {
        $lookup: {
          from: "customers",
          localField: "customer.customerId",
          foreignField: "_id",
          as: "customer.customerId",
        },
      },
      {
        $unwind: {
          path: "$customer.customerId",
          preserveNullAndEmptyArrays: true,
        },
      },

      // Populate warehouse
      {
        $lookup: {
          from: "warehouses",
          localField: "warehouse",
          foreignField: "_id",
          as: "warehouse",
        },
      },
      { $unwind: { path: "$warehouse", preserveNullAndEmptyArrays: true } },

      // Populate category
      {
        $lookup: {
          from: "categories",
          localField: "category",
          foreignField: "_id",
          as: "category",
        },
      },
      { $unwind: { path: "$category", preserveNullAndEmptyArrays: true } },

      // --- Nested Lookups for Items ---
      { $unwind: { path: "$items", preserveNullAndEmptyArrays: true } },

      // Populate items.product
      {
        $lookup: {
          from: "products",
          localField: "items.product",
          foreignField: "_id",
          as: "items.product"
        }
      },
      { $unwind: { path: "$items.product", preserveNullAndEmptyArrays: true } },

      // Populate items.unit
      {
        $lookup: {
          from: "units",
          localField: "items.unit",
          foreignField: "_id",
          as: "items.unit"
        }
      },
      { $unwind: { path: "$items.unit", preserveNullAndEmptyArrays: true } },

      // Group back items
      {
        $group: {
          _id: "$_id",
          root: { $first: "$$ROOT" },
          items: { $push: "$items" }
        }
      },
      {
        $replaceRoot: {
          newRoot: {
            $mergeObjects: ["$root", { items: "$items" }]
          }
        }
      },
      // --- End Nested Lookups for Items ---

      // Populate payments.accountId
      // Use similar unwind/group pattern for payments if multiple exist
      { $unwind: { path: "$payments", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "accounts",
          localField: "payments.accountId",
          foreignField: "_id",
          as: "payments.accountId",
        },
      },
      {
        $unwind: {
          path: "$payments.accountId",
          preserveNullAndEmptyArrays: true,
        },
      },

      // Group back to reconstruct the sales document
      {
        $group: {
          _id: "$_id",
          doc: { $first: "$$ROOT" },
          payments: { $push: "$payments" },
        },
      },
      {
        $replaceRoot: {
          newRoot: {
            $mergeObjects: [
              "$doc",
              {
                payments: "$payments",
              },
            ],
          },
        },
      },

      // Sort by date desc
      { $sort: { saleDate: -1 } }
    ]);

    return res
      .status(200)
      .json(new ApiResponse(200, sales, "Sales fetched successfully"));
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A document with the same ${field} '${value}' already exists.`,
        ),
      ); // Generic message
    }
    // Handle Mongoose validation errors
    if (error.name === "ValidationError") {
      const firstErrorField = Object.keys(error.errors)[0];
      let userFriendlyMessage = "Validation failed.";

      if (firstErrorField) {
        userFriendlyMessage = `The field ${firstErrorField} is required.`;
      }
      return next(new ApiError(400, userFriendlyMessage, error.errors));
    }
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
}

async function getSaleById(req, res, next) {
  try {
    const { id } = req.params;

    const sale = await Sales.findById(id)
      .populate("customer.customerId", "name phone location creditBalance")
      .populate("warehouse", "name location manager")
      .populate("category", "name")
      .populate("payments.accountId")
      .populate({ path: "unit", select: "name conversionFactor type", strictPopulate: false })
      .populate({
        path: "product",
        select: "name code quantity unit unitPrice LC",
        strictPopulate: false,
        populate: [
          { path: "unit", select: "name conversionFactor type" },
          { path: "LC", select: "basicInfo.lcNumber" }
        ]
      })
      .populate({
        path: "items.product",
        select: "name code quantity unit unitPrice LC",
        populate: [
          { path: "unit", select: "name conversionFactor type" },
          { path: "LC", select: "basicInfo.lcNumber" }
        ]
      })
      .populate("items.unit", "name conversionFactor type")
      .populate("createdBy", "name email")
      .populate("modifiedBy", "name email")
      .populate("deletedBy", "name email")
      .lean();

    if (!sale) {
      return next(new ApiError(404, "Sale not found"));
    }

    // Check isDeleted if necessary, or return 404
    /* if (sale.isDeleted) {
       return next(new ApiError(404, "Sale not found"));
    } */

    // --- Calculated Fields (Now Persisted) ---
    // Legacy support: If fields are missing (shouldn't happen after migration), we could recalc,
    // but for now we rely on the migrated data.
    // The previous code calculated these on the fly. Now we just trust the DB.

    // Clean up sensitive fields
    if (sale.createdBy) delete sale.createdBy.password;
    if (sale.modifiedBy) delete sale.modifiedBy.password;
    if (sale.deletedBy) delete sale.deletedBy.password;

    return res
      .status(200)
      .json(new ApiResponse(200, sale, "Sale fetched successfully"));
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    if (error.name === "CastError") {
      return next(new ApiError(400, "Invalid Sale ID"));
    }
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
}

async function updateSale(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const updateData = req.body;

    const sale = await Sales.findById(id).session(session)
      .populate("items.product")
      .populate("items.unit");

    if (!sale) {
      throw new ApiError(404, "Sale not found");
    }
    if (sale.isDeleted) {
      throw new ApiError(400, "Cannot update a sale that is in the trash.");
    }

    // 1. Lock Warehouse / Validation
    // Users cannot change the warehouse during an edit to avoid complex cross-warehouse transfer logic here.
    if (updateData.warehouse && updateData.warehouse !== sale.warehouse.toString()) {
      throw new ApiError(400, "Changing warehouse during edit is not allowed. Please delete and recreate the sale if you need to switch warehouses.");
    }
    const warehouseId = sale.warehouse;

    // 2. Prepare Items for Diffing
    // Current items in DB
    const oldItems = sale.items && sale.items.length > 0
      ? sale.items
      : (sale.product ? [{ product: sale.product, quantity: sale.quantity, unit: sale.unit }] : []);

    // New items from request (or fall back to old if not provided)
    // If updateData.items is provided, it replaces the old list.
    const newItemsRaw = updateData.items || oldItems;

    // Normalize newItems to ensure they have minimal required fields for calculation
    const newItems = newItemsRaw.map(i => ({
      product: i.productId || i.product._id || i.product,
      quantity: parseFloat(i.quantity),
      unit: i.unit._id || i.unit,
      pricePerUnit: parseFloat(i.pricePerUnit)
    }));

    // 3. Stock Reconciliation
    const oldStatus = sale.invoiceStatus;
    const newStatus = updateData.invoiceStatus || oldStatus;

    if (oldStatus !== newStatus) {
      // PROHIBIT STATUS TRANSITIONS that are complex until fully tested
      // For now we trust the logic, but let's be careful.
      if (oldStatus === "Not-invoiced" && newStatus === "Invoiced") {
        const diff = await SalesService.calculateStockDiff([], newItems, session);
        await SalesService.applyStockDiff(diff, session);
      } else if (oldStatus === "Invoiced" && newStatus === "Cancelled") {
        const diff = await SalesService.calculateStockDiff(oldItems, [], session);
        await SalesService.applyStockDiff(diff, session);
      } else if (oldStatus === "Cancelled" && newStatus === "Invoiced") {
        const diff = await SalesService.calculateStockDiff([], newItems, session);
        await SalesService.applyStockDiff(diff, session);
      } else if (oldStatus === "Invoiced" && newStatus === "Invoiced") {
        const diff = await SalesService.calculateStockDiff(oldItems, newItems, session);
        await SalesService.applyStockDiff(diff, session);
      }
    } else if (newStatus === "Invoiced") {
      const diff = await SalesService.calculateStockDiff(oldItems, newItems, session);
      await SalesService.applyStockDiff(diff, session);
    }

    // [NEW] 3.5. Validation: Ensure all new items belong to the correct warehouse
    // Re-validate stock is handled by calculateStockDiff, but generic warehouse check is good
    // calculateStockDiff already checks if product belongs to warehouse (lines 122 in service) - so we are good there.

    // 4. Recalculate Financials
    // Store old costs for reconciliation
    const oldCosts = sale.costs || [];

    if (updateData.items) sale.items = newItems;
    if (updateData.costs) sale.costs = updateData.costs;
    if (updateData.charges) sale.charges = updateData.charges;
    if (updateData.discount !== undefined) sale.discount = updateData.discount;
    if (updateData.invoiceStatus) sale.invoiceStatus = updateData.invoiceStatus;
    // ... notes/modifiedBy ...
    if (updateData.notes) sale.notes = updateData.notes;
    sale.modifiedBy = req.user?._id;

    // Recalculate Total Amount
    const totalAmount = Math.round(sale.items.reduce((sum, item) => sum + (item.quantity * item.pricePerUnit), 0) * 100) / 100;
    sale.totalAmount = totalAmount;

    // Trigger schema validation (pre-save hook calculates totalAmountToBePaid)
    await sale.validate();

    // [NEW] 4.5. Check Customer Credit Limit
    if (sale.customer?.customerId) {
      // We need to pass the *prospective* financials
      const costsTotal = sale.costs.reduce((acc, c) => acc + c.amount, 0);
      const chargesTotal = sale.charges.reduce((acc, c) => acc + c.amount, 0);
      const currentTotalPaid = sale.payments.reduce((acc, p) => acc + p.amount, 0); // Assuming payments largely static here

      await SalesService.checkCustomerCreditLimit(
        sale.customer.customerId,
        {
          totalAmount: sale.totalAmount,
          costsTotal,
          chargesTotal,
          discount: sale.discount,
          totalPaid: currentTotalPaid // We check against what has been paid so far
        },
        session
      );
    }

    // [NEW] 4.6 Reconcile Costs (Financials)
    if (updateData.costs) {
      await SalesService.reconcileCosts(
        oldCosts,
        updateData.costs,
        sale,
        session,
        req.businessTimezone
      );
    }

    // 5. Strict Financial Check
    const totalPaid = Math.round(sale.payments.reduce((acc, p) => acc + p.amount, 0) * 100) / 100;

    // If the update reduces the total amount below what has already been paid, we prevent it.
    // The user must refund/remove payments first to lower the paid amount.
    if (totalPaid > sale.totalAmountToBePaid) {
      throw new ApiError(
        400,
        `Cannot update sale because the new total (${sale.totalAmountToBePaid}) is less than the amount already paid (${totalPaid}). Please remove or refund payments first.`
      );
    }

    await sale.save({ session });
    // --- FINANCIAL RECONCILIATION ---
    await SalesService.reconcileSaleFinancials(sale._id, session);
    // --------------------------------

    await session.commitTransaction();
    session.endSession();

    return res
      .status(200)
      .json(new ApiResponse(200, sale, "Sale updated successfully"));
  } catch (error) {
    if (session.inTransaction()) { // Check before aborting
      await session.abortTransaction();
    }
    session.endSession();

    if (error instanceof ApiError) return next(error);

    // Mongoose Validation Errors
    if (error.name === "ValidationError") {
      const firstErrorField = Object.keys(error.errors)[0];
      return next(new ApiError(400, error.errors[firstErrorField].message));
    }

    logger.error(error);
    next(new ApiError(500, "An unexpected error occurred."));
  }
}

const { moveToTrash } = require("../controllers/trash.controller");

// ... (other functions remain the same) ...

async function deleteSale(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const { user } = req; // Assuming user is available in the request

    const saleToDelete = await Sales.findById(id)
      .session(session)
      .populate({ path: "unit", strictPopulate: false }) // Legacy
      .populate({
        path: "product",
        strictPopulate: false,
        populate: {
          path: "unit",
        },
      }) // Legacy
      .populate({
        path: "items.product",
        populate: {
          path: "unit"
        }
      })
      .populate("items.unit");

    if (!saleToDelete) {
      throw new ApiError(404, "Sale not found");
    }

    if (saleToDelete.isDeleted) {
      throw new ApiError(400, "Sale is already in the trash");
    }

    // Restore stock for MULTI-ITEM sales
    if (saleToDelete.items && saleToDelete.items.length > 0) {
      for (const item of saleToDelete.items) {
        if (item.product && item.unit) {
          const product = item.product;
          const saleUnit = item.unit;

          // Check for unit compatibility (should be guaranteed by creation, but good to be safe)
          if (product.unit && product.unit.type === saleUnit.type) {
            const qty = item.quantity;
            const quantityInBase = qty * (saleUnit.conversionFactor || 1);
            const quantityToRestore = quantityInBase / (product.unit.conversionFactor || 1);

            await Product.findByIdAndUpdate(
              product._id,
              { $inc: { quantity: quantityToRestore } },
              { session }
            );
          }
        }
      }
    }
    // Fallback: Restore stock for LEGACY single-item sales
    else if (saleToDelete.product && saleToDelete.unit) {
      const product = saleToDelete.product;
      const saleUnit = saleToDelete.unit;

      if (product.unit && product.unit.type === saleUnit.type) {
        const deletedSaleQuantityInBaseUnit =
          saleToDelete.quantity * saleUnit.conversionFactor;
        const quantityToRestoreToProduct =
          deletedSaleQuantityInBaseUnit / product.unit.conversionFactor;

        await Product.findByIdAndUpdate(
          product._id,
          { $inc: { quantity: quantityToRestoreToProduct } },
          { session },
        );
      }
    }

    // Only reverse financial transactions if there were actual payments made.
    if (saleToDelete.payments && saleToDelete.payments.length > 0) {
      // DailyCash Gatekeeper Check (only for sales with payments that need reversal)
      const today = startOfDay(now());
      const dailyCash = await DailyCash.findOne({ date: today })
        .sort({ createdAt: -1 })
        .session(session);

      if (!dailyCash || dailyCash.status === "Closed") {
        throw new ApiError(
          400,
          `Daily cash is closed for ${today.toDateString()}. Cannot delete sale with existing payments, as reversals cannot be processed.`,
        );
      }
      // Reverse financial transactions for payments
      for (const payment of saleToDelete.payments) {
        if (payment.method === "Customer Credit") {
          // Refund Customer Credit back to customer's balance
          if (saleToDelete.customer?.customerId) {
            await Customer.findByIdAndUpdate(
              saleToDelete.customer.customerId,
              { $inc: { creditBalance: payment.amount } },
              { session },
            );

            await CreditHistory.create(
              [
                {
                  customer: saleToDelete.customer.customerId,
                  amount: payment.amount,
                  type: "Credit",
                  reason: "Sale Deleted",
                  reference: saleToDelete._id,
                  referenceModel: "Sale",
                  description: `Refund for deleted Sale ID: ${saleToDelete.saleId}`,
                  createdBy: user?._id,
                },
              ],
              { session },
            );
          }
        } else if (["Bank", "Mobile Banking", "Cash"].includes(payment.method)) {
          const account = await Account.findById(payment.accountId).session(
            session,
          );
          if (!account) {
            throw new ApiError(
              400,
              `Cannot delete sale because the associated account (ID: ${payment.accountId}) for payment is missing. Please restore the account first.`,
            );
          }
          if (account) {
            account.balance -= payment.amount;
            await account.save({ session });

            await Transaction.create(
              [
                {
                  name: "Sales Deletion Reversal",
                  accountId: payment.accountId,
                  date: now(),
                  description: `Reversal for Deleted Sale ID: ${saleToDelete.saleId}`,
                  transactionType: "Expense",
                  amount: payment.amount,
                  source: "Auto",
                  category: "Sales Reversal",
                  paymentMethod: payment.method,
                  reference: saleToDelete._id,
                  referenceModel: "Sale",
                },
              ],
              { session },
            );
          }
        }
      }
    }

    // Reverse Overpayment (Credit) if exists
    // If the sale resulted in an overpayment that was credited to the wallet, we must reverse it.
    if (saleToDelete.customer?.customerId) {
      // Validate customer existence for credit reversal
      const customerExists = await Customer.findOne({
        _id: saleToDelete.customer.customerId,
        isDeleted: { $ne: true }
      }).session(session);

      if (!customerExists) {
        // We can technically allow deletion if we just ignore the credit reversal, 
        // OR we can block it. Blocking is safer to avoid "magic" money behavior.
        throw new ApiError(400, "Cannot delete sale because the associated customer is missing or deleted. Please restore the customer first to process the financial reversal.");
      }

      const overpaymentCredit = await CreditHistory.findOne({
        reference: saleToDelete._id,
        reason: "Overpayment",
        type: "Credit",
      }).session(session);

      if (overpaymentCredit) {
        await Customer.findByIdAndUpdate(
          saleToDelete.customer.customerId,
          { $inc: { creditBalance: -overpaymentCredit.amount } },
          { session },
        );

        await CreditHistory.create(
          [
            {
              customer: saleToDelete.customer.customerId,
              amount: overpaymentCredit.amount,
              type: "Debit",
              reason: "Sale Deleted",
              reference: saleToDelete._id,
              referenceModel: "Sale",
              description: `Reversal of overpayment for deleted Sale ID: ${saleToDelete.saleId}`,
              createdBy: user?._id,
            },
          ],
          { session },
        );
      }
    }

    // Mark the sale as deleted
    saleToDelete.isDeleted = true;
    saleToDelete.status = "Deleted"; // Ensure 'status' field exists in schema if using it
    saleToDelete.deletedBy = user?._id || null;
    await saleToDelete.save({ session });

    // Move to trash
    await moveToTrash({
      docId: saleToDelete._id,
      modelName: "Sale",
      deletedBy: user?._id, // Pass the user's ID
    });

    await session.commitTransaction();
    session.endSession();

    return res
      .status(200)
      .json(new ApiResponse(200, null, "Sale moved to trash successfully"));
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    if (error instanceof ApiError) {
      return next(error);
    }
    logger.error("DeleteSale Error:", error);
    next(new ApiError(500, "Failed to move sale to trash. Please try again."));
  }
}

async function getSalesSummary(_, res, next) {
  try {
    const summary = await Sales.aggregate([
      {
        $match: {
          isDeleted: { $ne: true },
        },
      },
      {
        $group: {
          _id: null,
          totalSales: { $sum: "$totalAmount" },
          totalTransactions: { $sum: 1 },
          dailyData: {
            $push: {
              date: {
                $dateToString: {
                  format: "%Y-%m-%d",
                  date: "$saleDate",
                },
              },
              amount: "$totalAmount",
            },
          },
        },
      },
      {
        $unwind: "$dailyData",
      },
      {
        $group: {
          _id: "$dailyData.date",
          dailyTotal: { $sum: "$dailyData.amount" },
          totalSales: { $first: "$totalSales" },
          totalTransactions: { $first: "$totalTransactions" },
        },
      },
      {
        $group: {
          _id: null,
          totalSales: { $first: "$totalSales" },
          totalTransactions: { $first: "$totalTransactions" },
          dailySummary: {
            $push: {
              k: "$_id",
              v: "$dailyTotal",
            },
          },
        },
      },
      {
        $project: {
          _id: 0,
          totalSales: 1,
          totalTransactions: 1,
          dailySummary: { $arrayToObject: "$dailySummary" },
        },
      },
    ]);

    const result = summary[0] || {
      totalSales: 0,
      totalTransactions: 0,
      dailySummary: {},
    };

    return res
      .status(200)
      .json(new ApiResponse(200, result, "Sales summary fetched successfully"));
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A document with the same ${field} '${value}' already exists.`,
        ),
      ); // Generic message
    }
    // Handle Mongoose validation errors
    if (error.name === "ValidationError") {
      const firstErrorField = Object.keys(error.errors)[0];
      let userFriendlyMessage = "Validation failed.";

      if (firstErrorField) {
        userFriendlyMessage = `The field ${firstErrorField} is required.`;
      }
      return next(new ApiError(400, userFriendlyMessage, error.errors));
    }
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
}

// get all sales invoices count in respose - suppose, total not invoiced sales (2), total paid {paid invoices are those, those's payment is completed} invoices sales (5)
async function getAll_invoices_status_count(req, res, next) {
  try {
    const stats = await Sales.aggregate([
      {
        $match: {
          isDeleted: { $ne: true },
        },
      },
      {
        $group: {
          _id: {
            invoiceStatus: "$invoiceStatus",
            paymentStatus: "$paymentStatus",
          },
          count: { $sum: 1 },
        },
      },
    ]);

    const counts = {
      notInvoiced: 0,
      paid: 0,
      due: 0,
      cancelled: 0,
    };

    stats.forEach((stat) => {
      if (stat._id.invoiceStatus === "Not-invoiced") {
        counts.notInvoiced += stat.count;
      } else if (stat._id.invoiceStatus === "Cancelled") {
        counts.cancelled += stat.count;
      } else if (stat._id.invoiceStatus === "Invoiced") {
        if (stat._id.paymentStatus === "Paid payment") {
          counts.paid += stat.count;
        } else if (stat._id.paymentStatus === "Due payment") {
          counts.due += stat.count;
        }
      }
    });

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          counts,
          "Invoice status count fetched successfully",
        ),
      );
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A document with the same ${field} '${value}' already exists.`,
        ),
      ); // Generic message
    }
    // Handle Mongoose validation errors
    if (error.name === "ValidationError") {
      const firstErrorField = Object.keys(error.errors)[0];
      let userFriendlyMessage = "Validation failed.";

      if (firstErrorField) {
        userFriendlyMessage = `The field ${firstErrorField} is required.`;
      }
      return next(new ApiError(400, userFriendlyMessage, error.errors));
    }
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
}

async function addPartialPayment(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const { amount, date, paymentMethod, accountId } = req.body;

    const validationErrors = [];
    if (!amount)
      validationErrors.push({ field: "amount", message: "Amount is required" });
    if (!date)
      validationErrors.push({ field: "date", message: "Date is required" });
    if (!paymentMethod)
      validationErrors.push({
        field: "paymentMethod",
        message: "Payment method is required",
      });

    // Account is required for standard payment methods
    if (
      ["Bank", "Mobile Banking", "Cash"].includes(paymentMethod) &&
      !accountId
    ) {
      validationErrors.push({
        field: "accountId",
        message: "Account is required for the payment",
      });
    }

    if (validationErrors.length > 0) {
      throw new ApiError(400, validationErrors[0].message, validationErrors);
    }

    const sale = await Sales.findById(id).session(session);
    if (!sale) {
      throw new ApiError(404, "Sale not found");
    }
    if (sale.isDeleted) {
      throw new ApiError(
        400,
        "Cannot add payment to a sale that is in the trash.",
      );
    }

    const payment = {
      amount,
      date,
      method: paymentMethod,
      accountId: accountId,
    };

    if (paymentMethod === "Customer Credit") {
      if (!sale.customer || !sale.customer.customerId) {
        throw new ApiError(
          400,
          "Guest/Manual customers cannot pay with Customer Credit.",
        );
      }

      const customer = await Customer.findById(
        sale.customer.customerId,
      ).session(session);

      // Atomic deduction with balance guard — prevents race conditions
      const updatedCustomer = await Customer.findOneAndUpdate(
        { _id: sale.customer.customerId, creditBalance: { $gte: amount } },
        { $inc: { creditBalance: -amount } },
        { session, new: true },
      );

      if (!updatedCustomer) {
        throw new ApiError(
          400,
          `Insufficient credit balance. Available: ${customer?.creditBalance || 0}, Required: ${amount}`,
        );
      }

      // Record Credit History
      await CreditHistory.create(
        [
          {
            customer: sale.customer.customerId,
            amount: amount,
            type: "Debit",
            reason: "Purchase",
            reference: sale._id,
            referenceModel: "Sale",
            description: `Partial payment for Sale ID: ${sale.saleId}`,
            createdBy: req.user?._id,
          },
        ],
        { session },
      );
    } else if (["Bank", "Mobile Banking", "Cash"].includes(paymentMethod)) {
      // 1. DailyCash Gatekeeper Check
      const paymentDateNormalized = startOfDay(
        new Date(date),
        req.businessTimezone,
      );
      const dailyCash = await DailyCash.findOne({ date: paymentDateNormalized })
        .sort({ createdAt: -1 })
        .select("_id status date")
        .session(session)
        .lean();

      if (!dailyCash || dailyCash.status === "Closed") {
        throw new ApiError(
          400,
          `Daily cash is closed for ${paymentDateNormalized.toDateString()}. Cannot record payment.`,
        );
      }

      const account = await Account.findById(accountId).session(session);
      if (!account) {
        throw new ApiError(404, "Account not found");
      }

      // Validate that the account type matches the payment method
      const expectedAccountType =
        paymentMethod === "Mobile Banking" ? "Mobile Banking" : paymentMethod;
      if (account.accountType !== expectedAccountType) {
        throw new ApiError(
          400,
          `Payment method '${paymentMethod}' requires a '${expectedAccountType}' account, but a '${account.accountType}' account was provided.`,
        );
      }

      account.balance += amount;
      await account.save({ session });

      await Transaction.create(
        [
          {
            accountId: accountId,
            date,
            description: `Partial payment received for Sale ID: ${sale.saleId} from ${sale.customer.name} via ${paymentMethod} Account: ${formatAccountLabel(account)}.`,
            transactionType: "Income",
            amount,
            name: "Sales Partial Payment",
            source: "Auto",
            category: "Sales",
            paymentMethod: paymentMethod,
            reference: sale._id,
            referenceModel: "Sale",
            miscReference: {
              saleId: sale.saleId,
              customerName: sale.customer.name,
              paymentAmount: amount,
              paymentMethod: paymentMethod,
            },
          },
        ],
        { session },
      );
    } // Correctly close the if block here

    // These operations should happen regardless of the payment method specific logic
    sale.payments.push(payment);
    sale.modifiedBy = req.user?._id || null;

    // --- Strict Payment Validation ---
    const totalPaid = sale.payments.reduce((acc, p) => acc + p.amount, 0);

    if (totalPaid > sale.totalAmountToBePaid) {
      throw new ApiError(
        400,
        `Payment amount (${totalPaid}) cannot exceed the total amount to be paid (${sale.totalAmountToBePaid}).`
      );
    }

    await sale.save({ session });

    // --- FINANCIAL RECONCILIATION ---
    await SalesService.reconcileSaleFinancials(sale._id, session);
    // --------------------------------

    await session.commitTransaction();
    session.endSession();

    return res
      .status(200)
      .json(new ApiResponse(200, sale, "Partial payment added successfully"));
  } catch (error) {
    // The catch block now properly follows the try block
    await session.abortTransaction();
    session.endSession();

    // If the error is already one of our custom ApiErrors, just pass it along.
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A sale with the same ${field} '${value}' already exists.`,
        ),
      ); // Generic message for sales
    }
    // Handle Mongoose validation errors
    if (error.name === "ValidationError") {
      const firstErrorField = Object.keys(error.errors)[0];
      let userFriendlyMessage = "Validation failed.";

      if (firstErrorField) {
        userFriendlyMessage = `The field ${firstErrorField} is required.`;
      }
      return next(new ApiError(400, userFriendlyMessage, error.errors));
    }
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
}

async function getSalesByCustomerId(req, res, next) {
  try {
    const { customerId } = req.params;
    const { invoiceStatus, paymentStatus, page = 1, limit = 10 } = req.query;

    if (!mongoose.Types.ObjectId.isValid(customerId)) {
      return next(new ApiError(400, "Invalid customer ID"));
    }

    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;

    const pipeline = [];

    // Stage 1: Match by customer and other filters
    const matchQuery = {
      "customer.customerId": new mongoose.Types.ObjectId(customerId),
      isDeleted: { $ne: true },
    };
    if (invoiceStatus) matchQuery.invoiceStatus = invoiceStatus;
    if (paymentStatus) matchQuery.paymentStatus = paymentStatus;
    pipeline.push({ $match: matchQuery });

    // Stage 2: Facet for data and count
    pipeline.push({
      $facet: {
        docs: [
          { $sort: { saleDate: -1 } },
          { $skip: skip },
          { $limit: limitNum },
          // Lookup for multi-product items
          {
            $lookup: {
              from: "products",
              localField: "items.product",
              foreignField: "_id",
              as: "_itemProducts",
            },
          },
          {
            $lookup: {
              from: "units",
              localField: "items.unit",
              foreignField: "_id",
              as: "_itemUnits",
            },
          },
          // Legacy single-product lookups (for old data)
          {
            $lookup: {
              from: "products",
              localField: "product",
              foreignField: "_id",
              as: "product",
            },
          },
          {
            $lookup: {
              from: "units",
              localField: "unit",
              foreignField: "_id",
              as: "unit",
            },
          },
          { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
          { $unwind: { path: "$unit", preserveNullAndEmptyArrays: true } },
          // Map items to include populated product/unit names
          {
            $addFields: {
              items: {
                $map: {
                  input: "$items",
                  as: "item",
                  in: {
                    product: {
                      $let: {
                        vars: {
                          matchedProduct: {
                            $arrayElemAt: [
                              {
                                $filter: {
                                  input: "$_itemProducts",
                                  as: "p",
                                  cond: { $eq: ["$$p._id", "$$item.product"] },
                                },
                              },
                              0,
                            ],
                          },
                        },
                        in: {
                          _id: "$$matchedProduct._id",
                          name: "$$matchedProduct.name",
                        },
                      },
                    },
                    unit: {
                      $let: {
                        vars: {
                          matchedUnit: {
                            $arrayElemAt: [
                              {
                                $filter: {
                                  input: "$_itemUnits",
                                  as: "u",
                                  cond: { $eq: ["$$u._id", "$$item.unit"] },
                                },
                              },
                              0,
                            ],
                          },
                        },
                        in: {
                          _id: "$$matchedUnit._id",
                          name: "$$matchedUnit.name",
                        },
                      },
                    },
                    quantity: "$$item.quantity",
                    pricePerUnit: "$$item.pricePerUnit",
                    total: "$$item.total",
                  },
                },
              },
            },
          },
          // Final projection
          {
            $project: {
              saleId: 1,
              saleDate: 1,
              items: 1,
              totalAmount: 1,
              totalAmountToBePaid: 1,
              invoiceStatus: 1,
              paymentStatus: 1,
              balanceDue: 1,
              totalPaid: 1,
              payments: 1,
              // Legacy single-product fields
              quantity: 1,
              pricePerUnit: 1,
              product: {
                _id: "$product._id",
                name: "$product.name",
              },
              unit: {
                _id: "$unit._id",
                name: "$unit.name",
              },
            },
          },
        ],
        totalDocs: [{ $count: "count" }],
      },
    });

    const results = await Sales.aggregate(pipeline);
    const salesResult = results[0];

    const totalDocs =
      salesResult.totalDocs.length > 0 ? salesResult.totalDocs[0].count : 0;
    const totalPages = Math.ceil(totalDocs / limitNum);

    return res.status(200).json(
      new ApiResponse(
        200,
        {
          sales: salesResult.docs,
          totalPages: totalPages,
          currentPage: pageNum,
          totalItems: totalDocs,
        },
        "Customer sales fetched successfully",
      ),
    );
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A document with the same ${field} '${value}' already exists.`,
        ),
      ); // Generic message
    }
    // Handle Mongoose validation errors
    if (error.name === "ValidationError") {
      const firstErrorField = Object.keys(error.errors)[0];
      let userFriendlyMessage = "Validation failed.";

      if (firstErrorField) {
        userFriendlyMessage = `The field ${firstErrorField} is required.`;
      }
      return next(new ApiError(400, userFriendlyMessage, error.errors));
    }
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
}

async function cancelSale(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;

    const saleToCancel = await Sales.findById(id)
      .session(session)
      .populate({ path: "unit", strictPopulate: false })
      .populate({
        path: "product",
        strictPopulate: false,
        populate: {
          path: "unit",
        },
      })
      .populate({
        path: "items.product",
        strictPopulate: false, // In case items.product is not in schema (unlikely but safe)
        populate: {
          path: "unit",
        },
      })
      .populate({ path: "items.unit", strictPopulate: false });

    if (!saleToCancel) {
      throw new ApiError(404, "Sale not found");
    }

    if (saleToCancel.isDeleted) {
      throw new ApiError(
        400,
        "Cannot cancel a sale that is already in the trash.",
      );
    }

    if (saleToCancel.invoiceStatus === "Cancelled") {
      throw new ApiError(400, "Sale is already cancelled");
    }

    // DailyCash Gatekeeper Check for reversal transactions
    const today = startOfDay(now(), req.businessTimezone);
    const dailyCash = await DailyCash.findOne({ date: today })
      .sort({ createdAt: -1 })
      .session(session);

    if (!dailyCash || dailyCash.status === "Closed") {
      throw new ApiError(
        400,
        `Daily cash is closed for ${today.toDateString()}. Cannot cancel sales payments.`,
      );
    }

    // Reverse Overpayment (Credit) if exists
    // If the sale resulted in an overpayment that was credited to the wallet, we must reverse it.
    if (saleToCancel.customer?.customerId) {
      const overpaymentCredit = await CreditHistory.findOne({
        reference: saleToCancel._id,
        reason: "Overpayment",
        type: "Credit",
      }).session(session);

      if (overpaymentCredit) {
        await Customer.findByIdAndUpdate(
          saleToCancel.customer.customerId,
          { $inc: { creditBalance: -overpaymentCredit.amount } },
          { session },
        );

        await CreditHistory.create(
          [
            {
              customer: saleToCancel.customer.customerId,
              amount: overpaymentCredit.amount,
              type: "Debit",
              reason: "Sale Cancelled",
              reference: saleToCancel._id,
              referenceModel: "Sale",
              description: `Reversal of overpayment for cancelled Sale ID: ${saleToCancel.saleId}`,
              createdBy: req.user?._id,
            },
          ],
          { session },
        );
      }
    }

    // Reverse financial transactions by creating counter-transactions
    for (const payment of saleToCancel.payments) {
      if (payment.method === "Customer Credit") {
        // Refund Customer Credit back to customer's balance
        if (saleToCancel.customer?.customerId) {
          await Customer.findByIdAndUpdate(
            saleToCancel.customer.customerId,
            { $inc: { creditBalance: payment.amount } },
            { session },
          );

          await CreditHistory.create(
            [
              {
                customer: saleToCancel.customer.customerId,
                amount: payment.amount,
                type: "Credit",
                reason: "Sale Cancelled",
                reference: saleToCancel._id,
                referenceModel: "Sale",
                description: `Refund for cancelled Sale ID: ${saleToCancel.saleId}`,
                createdBy: req.user?._id,
              },
            ],
            { session },
          );
        }
      } else if (["Bank", "Mobile Banking", "Cash"].includes(payment.method)) {
        const account = await Account.findById(payment.accountId).session(
          session,
        );
        if (account) {
          account.balance -= payment.amount;
          await account.save({ session });

          await Transaction.create(
            [
              {
                name: "Sales Cancellation Reversal",
                accountId: payment.accountId,
                date: now(),
                description: `Reversal of payment for cancelled Sale ID: ${saleToCancel.saleId} (Customer: ${saleToCancel.customer.name}) via ${payment.method}.`,
                transactionType: "Expense", // To reverse the Income
                amount: payment.amount,
                source: "Auto", // Auto generated reversal
                category: "Sales Reversal (Cancelled)",
                paymentMethod: payment.method,
                reference: saleToCancel._id,
                referenceModel: "Sale",
                miscReference: {
                  saleId: saleToCancel.saleId,
                  customerName: saleToCancel.customer.name,
                  originalPaymentAmount: payment.amount,
                  originalPaymentMethod: payment.method,
                },
              },
            ],
            { session },
          );
        }
      }
    }

    // Reverse expense transactions for costs
    for (const cost of saleToCancel.costs) {
      if (cost.accountId) {
        const account = await Account.findById(cost.accountId).session(session);
        if (account) {
          account.balance += cost.amount;
          await account.save({ session });

          await Transaction.create(
            [
              {
                accountId: cost.accountId,
                date: now(),
                description: `Reversal of cost for cancelled Sale ID: ${saleToCancel.saleId} - ${cost.name}`,
                transactionType: "Income", // To reverse the Expense
                amount: cost.amount,
                source: "Auto",
                category: "Sales Expense Reversal",
                reference: saleToCancel._id,
                referenceModel: "Sale",
                miscReference: {
                  saleId: saleToCancel.saleId,
                  costName: cost.name,
                  costAmount: cost.amount,
                },
              },
            ],
            { session },
          );
        }
      }
    }

    // Restore product quantity with unit conversion
    if (saleToCancel.product && saleToCancel.unit) {
      const product = saleToCancel.product; // Product is already populated
      const saleUnit = saleToCancel.unit; // Sale unit is already populated

      // Check if units are compatible (same type)
      if (product.unit.type !== saleUnit.type) {
        console.error(
          `Data inconsistency: Product unit type (${product.unit.type}) does not match sale unit type (${saleUnit.type}) during sale cancellation.`,
        );
        await Product.findByIdAndUpdate(
          product._id,
          {
            $inc: { quantity: saleToCancel.quantity },
          },
          { session },
        );
      } else {
        const cancelledSaleQuantityInBaseUnit =
          saleToCancel.quantity * saleUnit.conversionFactor;
        const quantityToRestoreToProduct =
          cancelledSaleQuantityInBaseUnit / product.unit.conversionFactor;

        await Product.findByIdAndUpdate(
          product._id,
          {
            $inc: { quantity: quantityToRestoreToProduct },
          },
          { session },
        );
      }
    }

    // Remove sale from customer's transactions if it's a registered customer
    if (saleToCancel.customer && saleToCancel.customer.customerId) {
      await Customer.findByIdAndUpdate(
        saleToCancel.customer.customerId,
        {
          $pull: { transactions: saleToCancel._id },
        },
        { session },
      );
    }

    saleToCancel.invoiceStatus = "Cancelled";
    saleToCancel.paymentStatus = "N/A"; // Clear payment status for cancelled sales
    await saleToCancel.save({ session });

    await session.commitTransaction();
    session.endSession();

    return res
      .status(200)
      .json(new ApiResponse(200, saleToCancel, "Sale cancelled successfully"));
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A sale with the same ${field} '${value}' already exists.`,
        ),
      ); // Generic message for sales
    }
    // Handle Mongoose validation errors
    if (error.name === "ValidationError") {
      const firstErrorField = Object.keys(error.errors)[0];
      let userFriendlyMessage = "Validation failed.";

      if (firstErrorField) {
        userFriendlyMessage = `The field ${firstErrorField} is required.`;
      }
      return next(new ApiError(400, userFriendlyMessage, error.errors));
    }
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
}

async function getPaginatedSalesSummary(req, res, next) {
  try {
    const {
      page = 1,
      limit = 10,
      invoiceStatus,
      paymentStatus,
      search,
      sortBy,
      sortOrder = "desc", // default to descending order
    } = req.query;

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // --- PIPELINE FOR FILTERING & SORTING & PAGINATION ---
    const pipeline = [];

    // 1. Join Collections for Search/Sort Criteria
    pipeline.push({
      $lookup: {
        from: "customers",
        localField: "customer.customerId",
        foreignField: "_id",
        as: "customerLookup",
      },
    });
    // We don't strictly need to unwind if we just match on "customerLookup.name" (mongo handles array match),
    // but unwinding makes sorting by single name deterministice.
    pipeline.push({
      $unwind: { path: "$customerLookup", preserveNullAndEmptyArrays: true },
    });

    // Lookup Products (from items array)
    // localField "items.product" will return an array of Product IDs
    pipeline.push({
      $lookup: {
        from: "products",
        localField: "items.product",
        foreignField: "_id",
        as: "productDetails", // This will be an ARRAY of products
      },
    });

    // Lookup LCs (from items.product.LC) -> complex for array, but for search we can try
    // Just looking up products is usually enough for "Search by Product Name"

    // 2. Computed Fields (for Sorting/Searching)
    pipeline.push({
      $addFields: {
        finalCustomerName: {
          $ifNull: ["$customerLookup.name", "$customer.name"],
        },
        // For searching/sorting by product name, we can take the first one or join them?
        // Let's create a string of all product names for searching
        allProductNames: "$productDetails.name",
        // For sorting by product name, use the first one
        primaryProductName: { $arrayElemAt: ["$productDetails.name", 0] },
        // Calculate Total Quantity (sum of items.quantity)
        totalQuantity: { $sum: "$items.quantity" },
      },
    });

    // 3. Match / Filter
    const matchConditions = {
      isDeleted: { $ne: true },
    };

    if (invoiceStatus) matchConditions.invoiceStatus = invoiceStatus;
    if (paymentStatus) matchConditions.paymentStatus = paymentStatus;

    if (search) {
      const searchRegex = new RegExp(search, "i");
      matchConditions.$or = [
        { finalCustomerName: searchRegex },
        { allProductNames: searchRegex }, // Matches if ANY product name matches
        { saleId: searchRegex },
      ];
      // Numeric search
      if (!isNaN(parseFloat(search))) {
        matchConditions.$or.push({ totalAmountToBePaid: parseFloat(search) });
      }
    }

    pipeline.push({ $match: matchConditions });

    // 4. Sort Configuration
    const sort = {};
    const sortDir = sortOrder === "asc" ? 1 : -1;

    if (sortBy) {
      if (sortBy === "saleDate") sort.saleDate = sortDir;
      else if (sortBy === "totalAmountToBePaid") sort.totalAmountToBePaid = sortDir;
      else if (sortBy === "quantity") sort.totalQuantity = sortDir;
      else if (sortBy === "customerName") sort.finalCustomerName = sortDir;
      else if (sortBy === "productName") sort.primaryProductName = sortDir;
      else sort.saleDate = -1; // Fallback
    } else {
      sort.saleDate = -1;
    }

    // 5. Facet: Get Metadata (Count) and Data (IDs only)
    pipeline.push({
      $facet: {
        metadata: [{ $count: "totalSales" }],
        data: [
          { $sort: sort },
          { $skip: skip },
          { $limit: limitNum },
          { $project: { _id: 1 } }, // Only project the IDs
        ],
      },
    });

    // EXECUTE PIPELINE
    const result = await Sales.aggregate(pipeline);

    const facetData = result[0].data;
    const totalSales = result[0].metadata[0] ? result[0].metadata[0].totalSales : 0;
    const totalPages = Math.ceil(totalSales / limitNum);

    if (facetData.length === 0) {
      return res.status(200).json(
        new ApiResponse(
          200,
          {
            sales: [],
            totalSales: 0,
            page: pageNum,
            limit: limitNum,
            totalPages: 0,
          },
          "Sales summary fetched successfully"
        )
      );
    }

    // 6. Hydrate the Data (Fetch full docs with population)
    const saleIds = facetData.map((item) => item._id);

    const sales = await Sales.find({ _id: { $in: saleIds } })
      .populate("customer.customerId", "name phone")
      .populate("items.product", "name") // Populate product details in items
      .populate("items.unit", "name")    // Populate unit details in items
      .lean();

    // 7. Re-order results to match the specific sort order from Aggregation
    // (Sales.find returns in undefined order or insertion order, not $in order)
    const salesMap = new Map(sales.map((s) => [s._id.toString(), s]));
    const orderedSales = saleIds
      .map((id) => salesMap.get(id.toString()))
      .filter((s) => s); // Filter out any undefined (shouldn't happen)

    return res.status(200).json(
      new ApiResponse(
        200,
        {
          sales: orderedSales,
          totalSales,
          page: pageNum,
          limit: limitNum,
          totalPages,
        },
        "Sales summary fetched successfully"
      )
    );
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    logger.error("Error in getPaginatedSalesSummary:", error);
    next(new ApiError(500, "Failed to fetch sales summary", [], error.message));
  }
}

module.exports = {
  createSale,
  getAllSales,
  getSaleById,
  updateSale,
  deleteSale,
  getSalesSummary,
  getAll_invoices_status_count,
  addPartialPayment,
  cancelSale,
  getSalesByCustomerId,
  getPaginatedSalesSummary,
};
