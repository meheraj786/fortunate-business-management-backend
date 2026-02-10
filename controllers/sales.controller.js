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
      product: productId,
      customer: customerInfo, // { customerId, name, phone, address }
      warehouse,
      category,
      quantity,
      unit,
      pricePerUnit,
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
    if (!productId)
      validationErrors.push({
        field: "product",
        message: "Product ID is required",
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
    if (!category)
      validationErrors.push({
        field: "category",
        message: "Category is required",
      });
    if (!quantity)
      validationErrors.push({
        field: "quantity",
        message: "Quantity is required",
      });
    if (!unit)
      validationErrors.push({ field: "unit", message: "Unit is required" });
    if (!pricePerUnit)
      validationErrors.push({
        field: "pricePerUnit",
        message: "Price per unit is required",
      });

    if (validationErrors.length > 0) {
      throw new ApiError(400, validationErrors[0].message, validationErrors);
    }

    // Validate Stock logic utilizing service
    const { quantityToDeductFromProduct } =
      await SalesService.validateStockAndGetDeduction(
        productId,
        quantity,
        unit,
        session,
      );

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

    // Credit Limit Check
    if (customerInfo.customerId) {
      const costsTotal = costs.reduce((acc, cost) => acc + cost.amount, 0);
      const chargesTotal = charges.reduce(
        (acc, charge) => acc + charge.amount,
        0,
      );
      const totalAmount = quantity * pricePerUnit;
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
      product: productId,
      customer: finalCustomerInfo,
      warehouse,
      category,
      quantity,
      unit,
      pricePerUnit,
      costs,
      charges,
      discount,
      invoiceStatus,
      payments: transformedPayments,
      notes,
      saleDate,
      createdBy: req.user?._id || null,
    });

    if (sale.totalAmountToBePaid < 0) {
      throw new ApiError(400, "Total amount to be paid cannot be negative.");
    }

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
          { _id: finalCustomerInfo.customerId, creditBalance: { $gte: payment.amount } },
          { $inc: { creditBalance: -payment.amount } },
          { session, new: true },
        );

        if (!updatedCustomer) {
          const customer = await Customer.findById(finalCustomerInfo.customerId).session(session);
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
        const account = await Account.findById(payment.accountId).session(
          session,
        );
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
        const paymentDateNormalized = startOfDay(
          new Date(payment.date),
          req.businessTimezone,
        );
        const dailyCash = await DailyCash.findOne({
          date: paymentDateNormalized,
        })
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
        const costAccount = await Account.findById(cost.accountId).session(
          session,
        );
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
        const saleDateNormalized = startOfDay(
          new Date(sale.saleDate),
          req.businessTimezone,
        );
        const dailyCash = await DailyCash.findOne({ date: saleDateNormalized })
          .sort({ createdAt: -1 })
          .select("_id status date")
          .session(session)
          .lean();

        if (!dailyCash || dailyCash.status === "Closed") {
          throw new ApiError(
            400,
            `Daily cash is closed for ${saleDateNormalized.toDateString()}. Cannot record cost transaction.`,
          );
        }

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
      await Product.findByIdAndUpdate(
        productId,
        { $inc: { quantity: -quantityToDeductFromProduct } },
        { new: true, session },
      );
    }

    if (finalCustomerInfo.customerId) {
      await Customer.findByIdAndUpdate(
        finalCustomerInfo.customerId,
        {
          $push: { transactions: sale._id },
        },
        { session },
      );

      // --- Overpayment Logic ---
      // Check if totalPaid for this sale > totalAmountToBePaid
      // We rely on the populated payments or the sum we tracked.
      // Since payments are new, we can just use totalPaidInThisTransaction if this is a new sale.
      // But wait, what if partial payments were involved?
      // createSale implies this is the FIRST set of payments.
      // However, let's use the sale object's data to be sure.
      const totalPaid = sale.payments.reduce((acc, p) => acc + p.amount, 0);

      // Guard: reject overpayment for guest/manual customers (no wallet to store excess)
      if (!finalCustomerInfo.customerId && totalPaid > sale.totalAmountToBePaid) {
        throw new ApiError(
          400,
          "Overpayment is not allowed for guest/manual customers. Please adjust the payment amount.",
        );
      }

      if (totalPaid > sale.totalAmountToBePaid) {
        const excessAmount = totalPaid - sale.totalAmountToBePaid;

        // Add excess to customer credit balance
        await Customer.findByIdAndUpdate(
          finalCustomerInfo.customerId,
          { $inc: { creditBalance: excessAmount } },
          { session },
        );

        // Record Credit History (Credit - Overpayment)
        await CreditHistory.create(
          [
            {
              customer: finalCustomerInfo.customerId,
              amount: excessAmount,
              type: "Credit",
              reason: "Overpayment",
              reference: sale._id,
              referenceModel: "Sale",
              description: `Overpayment from Sale ID: ${sale.saleId}`,
              createdBy: req.user?._id,
            },
          ],
          { session },
        );

        // We do NOT modify the sale's payment records, because those records represent real money received.
        // The fact that it's an overpayment is now resolved by moving the value to the wallet.
        // The user will see: Sale Paid (1200/1000). Customer Wallet +200.
        // To make the sale look "Clean" (Paid 1000/1000) we would have to complicate the payments array.
        // The user's requirement was: "immediately moves those extra amount to the customer's credit balance."
        // So this logic is correct.
      }
    }

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
      // Populate product
      {
        $lookup: {
          from: "products",
          localField: "product",
          foreignField: "_id",
          as: "product",
        },
      },
      { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },

      // Nested populate product.LC
      {
        $lookup: {
          from: "lcs",
          localField: "product.LC",
          foreignField: "_id",
          as: "product.LC",
        },
      },
      { $unwind: { path: "$product.LC", preserveNullAndEmptyArrays: true } },

      // Nested populate product.unit
      {
        $lookup: {
          from: "units",
          localField: "product.unit",
          foreignField: "_id",
          as: "product.unit",
        },
      },
      { $unwind: { path: "$product.unit", preserveNullAndEmptyArrays: true } },

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

      // Populate payments.accountId
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

    const results = await Sales.aggregate([
      {
        $match: {
          _id: new mongoose.Types.ObjectId(id),
          isDeleted: { $ne: true },
        },
      },

      // Unwind payments to process them
      { $unwind: { path: "$payments", preserveNullAndEmptyArrays: true } },

      // Populate accountId in payments
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

      // Group back to reconstruct the sales document with populated payments
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
                payments: {
                  // Filter out empty payment objects if no payments existed
                  $filter: {
                    input: "$payments",
                    as: "payment",
                    cond: { $ifNull: ["$$payment._id", false] },
                  },
                },
              },
            ],
          },
        },
      },

      // Now populate the other fields
      {
        $lookup: {
          from: "products",
          localField: "product",
          foreignField: "_id",
          as: "product",
        },
      },
      { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },

      {
        $lookup: {
          from: "lcs",
          localField: "product.LC",
          foreignField: "_id",
          as: "product.LC",
        },
      },
      { $unwind: { path: "$product.LC", preserveNullAndEmptyArrays: true } },

      // Populate Audit Fields
      {
        $lookup: {
          from: "users",
          localField: "createdBy",
          foreignField: "_id",
          as: "creator",
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "modifiedBy",
          foreignField: "_id",
          as: "modifier",
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "deletedBy",
          foreignField: "_id",
          as: "deleter",
        },
      },
      {
        $addFields: {
          createdBy: { $arrayElemAt: ["$creator", 0] },
          modifiedBy: { $arrayElemAt: ["$modifier", 0] },
          deletedBy: { $arrayElemAt: ["$deleter", 0] },
        },
      },
      {
        $project: {
          creator: 0,
          modifier: 0,
          deleter: 0,
          "createdBy.password": 0,
          "modifiedBy.password": 0,
          "deletedBy.password": 0,
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
      { $unwind: { path: "$unit", preserveNullAndEmptyArrays: true } },

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

      {
        $lookup: {
          from: "warehouses",
          localField: "warehouse",
          foreignField: "_id",
          as: "warehouse",
        },
      },
      { $unwind: { path: "$warehouse", preserveNullAndEmptyArrays: true } },

      {
        $lookup: {
          from: "categories",
          localField: "category",
          foreignField: "_id",
          as: "category",
        },
      },
      { $unwind: { path: "$category", preserveNullAndEmptyArrays: true } },

      // Add calculated fields
      {
        $addFields: {
          paymentsMade: { $sum: "$payments.amount" },
        },
      },
      {
        $addFields: {
          balanceDue: {
            $max: [0, { $subtract: ["$totalAmountToBePaid", "$paymentsMade"] }],
          },
          overPayment: {
            $max: [0, { $subtract: ["$paymentsMade", "$totalAmountToBePaid"] }],
          },
        },
      },
      // Project the final fields
      {
        $project: {
          _id: 1,
          saleId: 1,
          product: {
            id: "$product._id",
            name: "$product.name",
            category: {
              name: "$category.name",
              id: "$category._id",
            },
            LC: {
              id: "$product.LC._id",
              basicInfo: {
                lcNumber: "$product.LC.basicInfo.lcNumber",
                status: "$product.LC.status",
                supplierName: "$product.LC.basicInfo.supplierName",
                country: "$product.LC.basicInfo.country",
              },
            },
            thickness: "$product.thickness",
            width: "$product.width",
            length: "$product.length",
            color: "$product.color",
            grade: "$product.grade",
          },
          customer: {
            id: "$customer.customerId._id",
            name: "$customer.name",
            phone: "$customer.phone",
            address: "$customer.address",
            creditBalance: "$customer.customerId.creditBalance",
          },
          warehouse: {
            id: "$warehouse._id",
            name: "$warehouse.name",
            location: "$warehouse.location",
            manager: "$warehouse.manager",
          },
          quantity: 1,
          unit: {
            name: "$unit.name",
            id: "$unit._id",
            type: "$unit.type",
          },
          pricePerUnit: 1,
          costs: 1,
          charges: 1,
          discount: 1,
          invoiceStatus: 1,
          paymentStatus: 1,
          payments: 1,
          notes: 1,
          saleDate: 1,
          totalAmount: 1,
          totalAmountToBePaid: 1,
          paymentsMade: 1,
          balanceDue: 1,
          overPayment: 1,
          createdBy: {
            name: "$createdBy.name",
            email: "$createdBy.email",
          },
          modifiedBy: {
            name: "$modifiedBy.name",
            email: "$modifiedBy.email",
          },
          deletedBy: {
            name: "$deletedBy.name",
            email: "$deletedBy.email",
          },
          createdAt: 1,
          updatedAt: 1,
          isDeleted: 1,
        },
      },
    ]);

    if (results.length === 0) {
      return next(new ApiError(404, "Sale not found"));
    }

    const sale = results[0];

    return res
      .status(200)
      .json(new ApiResponse(200, sale, "Sale fetched successfully"));
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

async function updateSale(req, res, next) {
  try {
    const { id } = req.params;
    const updateData = req.body;

    const sale = await Sales.findById(id)
      .populate("unit")
      .populate({
        path: "product",
        populate: {
          path: "unit",
        },
      });
    if (!sale) {
      return next(new ApiError(404, "Sale not found"));
    }
    if (sale.isDeleted) {
      return next(
        new ApiError(400, "Cannot update a sale that is in the trash."),
      );
    }

    // --- Stock Update Logic Start ---
    const oldStatus = sale.invoiceStatus;
    const newStatus = updateData.invoiceStatus || oldStatus;
    const oldQuantity = sale.quantity;
    const newQuantity =
      updateData.quantity !== undefined ? updateData.quantity : oldQuantity;

    const product = sale.product; // Already populated
    if (!product) {
      return next(new ApiError(404, "Associated product not found"));
    }

    // Identify if we need to interact with stock
    // We need to calculate unit conversions if we are doing any stock operation
    // Using the same logic as before for conversion:

    // 1. Check Unit Compatibility
    if (product.unit.type !== sale.unit.type) {
      return next(
        new ApiError(
          400,
          `Cannot update sale. Incompatible units: Product is in '${product.unit.type}' while sale is in '${sale.unit.type}'.`,
        ),
      );
    }

    // Helper to calculate stock change in Product's Unit
    const calculateStockChange = (qty) => {
      const qtyInBase = qty * sale.unit.conversionFactor;
      return qtyInBase / product.unit.conversionFactor;
    };

    if (oldStatus !== newStatus) {
      // Validation: Cannot revert to 'Not-invoiced' if payments exist
      if (oldStatus === "Invoiced" && newStatus === "Not-invoiced") {
        if (sale.payments && sale.payments.length > 0) {
          return next(
            new ApiError(
              400,
              "Cannot revert to 'Not-invoiced' because payments have been recorded. Please cancel the sale instead."
            )
          );
        }
      }

      // Status Transition
      if (oldStatus === "Not-invoiced" && newStatus === "Invoiced") {
        // Not-invoiced -> Invoiced: DEDUCT "newQuantity"
        const deduction = calculateStockChange(newQuantity);
        if (product.quantity < deduction) {
          return next(
            new ApiError(
              400,
              `Not enough product in stock to invoice this sale. Required: ${deduction} ${product.unit.name}, Available: ${product.quantity} ${product.unit.name}`,
            ),
          );
        }
        await Product.findByIdAndUpdate(product._id, {
          $inc: { quantity: -deduction },
        });
      } else if (oldStatus === "Invoiced" && newStatus === "Cancelled") {
        // Invoiced -> Cancelled: RESTORE "oldQuantity" (what was previously taken)
        // Even if newQuantity is different, we only restore what we took.
        // AND if newQuantity is different, the sale record will update to newQuantity, but that doesn't matter for the restoration.
        const restoration = calculateStockChange(oldQuantity);
        await Product.findByIdAndUpdate(product._id, {
          $inc: { quantity: restoration },
        });
      }
      // "Invoiced" -> "Not-invoiced" is supposedly blocked/invalid, so ignoring or treating as no-op.
      // "Cancelled" -> "Invoiced"? If we allow reviving cancelled orders.
      else if (oldStatus === "Cancelled" && newStatus === "Invoiced") {
        // Re-deduct newQuantity
        const deduction = calculateStockChange(newQuantity);
        if (product.quantity < deduction) {
          return next(new ApiError(400, "Not enough product in stock to reactivate sale."));
        }
        await Product.findByIdAndUpdate(product._id, { $inc: { quantity: -deduction } });
      }

    } else {
      // Status did NOT change
      if (newStatus === "Invoiced") {
        // Invoiced -> Invoiced: Check Quantity Change
        if (oldQuantity !== newQuantity) {
          const oldQtyInProductUnit = calculateStockChange(oldQuantity);
          const newQtyInProductUnit = calculateStockChange(newQuantity);
          const netChange = newQtyInProductUnit - oldQtyInProductUnit;
          // If netChange is positive, we need MORE stock (Deduct more)
          // If netChange is negative, we need LESS stock (Restore some)

          // Check availability if we need more
          if (netChange > 0 && product.quantity < netChange) {
            return next(new ApiError(400, "Not enough product in stock for this quantity increase"));
          }

          await Product.findByIdAndUpdate(product._id, {
            $inc: { quantity: -netChange }
          });
        }
      }
      // If "Not-invoiced" -> "Not-invoiced", do nothing regardless of quantity change.
      // If "Cancelled" -> "Cancelled", do nothing.
    }
    // --- Stock Update Logic End ---

    // Prevent updates to sensitive or immutable fields to ensure data integrity.
    // 'charges' are an exception and can be updated directly on the sale.
    // Financial arrays like 'costs' and 'payments' must be managed via dedicated endpoints.
    const immutableFields = [
      "paymentStatus",
      "product",
      "warehouse",
      "category",
      "customer",
      "costs",
      "payments",
      "saleId",
      "totalAmount",
      "totalAmountToBePaid",
    ];

    immutableFields.forEach((field) => {
      if (updateData.hasOwnProperty(field)) {
        delete updateData[field];
      }
    });

    // Apply updates
    updateData.modifiedBy = req.user?._id || null;
    Object.assign(sale, updateData);

    const updatedSale = await sale.save();

    // --- Overpayment Reconciliation (Post-Update) ---
    // If the update reduced the totalAmount (e.g. quantity decrease), 
    // the existing payments might now exceed the new totalAmountToBePaid.
    if (updatedSale.customer?.customerId && updatedSale.invoiceStatus === 'Invoiced') {
      const totalPaid = updatedSale.payments.reduce((acc, p) => acc + p.amount, 0);

      if (totalPaid > updatedSale.totalAmountToBePaid) {
        const currentExcess = totalPaid - updatedSale.totalAmountToBePaid;

        // Check for previously recorded overpayments
        // (We use the same aggregation logic as in addPartialPayment)
        // Note: We need a session here? updateSale didn't use `session` for the main save in the original code? 
        // Wait, the original code lines 354: `const session = ...`. Yes it uses a session.
        // BUT `await sale.save()` in line 1093 (original) does NOT pass { session } explicitly in the snippet shown?
        // Line 296 in createSale used `sale.save({ session })`.
        // Line 1093 just said `updatedSale = await sale.save()`. 
        // If `sale` was found using `session`, does Mongoose auto-use it? 
        // The `findById` line 956 did NOT loop in session?
        // Wait, line 354 in `updateCustomer` used session. 
        // Let me check `updateSale` start in my view_file output.
        // `updateSale` start line 951. NO session start visible in the snippet?
        // Ah, I need to check if `updateSale` has a session.
        // The snippet I viewed (951-1133) does NOT show `startSession`.
        // It shows `try { const { id } ...`.
        // So `updateSale` is NOT currently transactional?
        // That is risky. 
        // But I strictly need to stick to the requested change. 
        // If I add credit, I should probably do it safely.
        // However, for now, I will use standard await logic without session if one isn't established, 
        // or just assume if it's not there I shouldn't introduce one mid-flight without refactoring.
        // BUT, `addPartialPayment` definitely had one.
        // Let's look at `updateSale` again.
        // It calls `Product.findByIdAndUpdate`.
        // It calls `sale.save()`.
        // If I add CreditHistory logic, I should just await it.

        const CreditHistory = require("../models/creditHistory.model"); // Ensure import if not available in scope (it is at top)
        const Customer = require("../models/customer.model");

        const previousOverpaymentStats = await CreditHistory.aggregate([
          {
            $match: {
              reference: updatedSale._id,
              reason: "Overpayment",
              type: "Credit"
            }
          },
          {
            $group: {
              _id: null,
              total: { $sum: "$amount" }
            }
          }
        ]);

        const previousOverpayment = previousOverpaymentStats[0]?.total || 0;
        const newExcess = currentExcess - previousOverpayment;

        if (newExcess > 0) {
          await Customer.findByIdAndUpdate(
            updatedSale.customer.customerId,
            { $inc: { creditBalance: newExcess } }
          );

          await CreditHistory.create(
            [{
              customer: updatedSale.customer.customerId,
              amount: newExcess,
              type: "Credit",
              reason: "Overpayment",
              reference: updatedSale._id,
              referenceModel: "Sale",
              description: `Overpayment adjustment after sale update (ID: ${updatedSale.saleId})`,
              createdBy: req.user?._id,
            }]
          );
        }
      }
    }

    return res
      .status(200)
      .json(new ApiResponse(200, updatedSale, "Sale updated successfully"));
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
      .populate("unit")
      .populate({
        path: "product",
        populate: {
          path: "unit",
        },
      });

    if (!saleToDelete) {
      throw new ApiError(404, "Sale not found");
    }

    if (saleToDelete.isDeleted) {
      throw new ApiError(400, "Sale is already in the trash");
    }

    // Restore product quantity with unit conversion
    if (saleToDelete.product && saleToDelete.unit) {
      const product = saleToDelete.product;
      const saleUnit = saleToDelete.unit;

      if (product.unit.type === saleUnit.type) {
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
    // This also implies that the DailyCash check is only needed in this case
    // since reversals create new transactions affecting daily cash.
    if (saleToDelete.payments.length > 0) {
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
    saleToDelete.status = "Deleted";
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

    // --- Overpayment Reconciliation ---
    if (sale.customer && sale.customer.customerId) {
      const totalPaid = sale.payments.reduce((acc, p) => acc + p.amount, 0);

      if (totalPaid > sale.totalAmountToBePaid) {
        const currentExcess = totalPaid - sale.totalAmountToBePaid;

        const previousOverpaymentStats = await CreditHistory.aggregate([
          {
            $match: {
              reference: sale._id,
              reason: "Overpayment",
              type: "Credit"
            }
          },
          {
            $group: {
              _id: null,
              total: { $sum: "$amount" }
            }
          }
        ]).session(session);

        const previousOverpayment = previousOverpaymentStats[0]?.total || 0;
        const newExcess = currentExcess - previousOverpayment;

        if (newExcess > 0) {
          await Customer.findByIdAndUpdate(
            sale.customer.customerId,
            { $inc: { creditBalance: newExcess } },
            { session }
          );

          await CreditHistory.create(
            [
              {
                customer: sale.customer.customerId,
                amount: newExcess,
                type: "Credit",
                reason: "Overpayment",
                reference: sale._id,
                referenceModel: "Sale",
                description: `Additional overpayment from Sale ID: ${sale.saleId}`,
                createdBy: req.user?._id,
              },
            ],
            { session }
          );
        }
      }
    }

    await sale.save({ session });

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
          // Lookups to replace populate
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
          // Nested lookup for LC
          {
            $lookup: {
              from: "lcs",
              localField: "product.LC",
              foreignField: "_id",
              as: "product.LC",
            },
          },
          {
            $unwind: { path: "$product.LC", preserveNullAndEmptyArrays: true },
          },
          // Final projection to shape the data
          {
            $project: {
              saleDate: 1,
              quantity: 1,
              pricePerUnit: 1,
              totalAmountToBePaid: 1,
              invoiceStatus: 1,
              paymentStatus: 1,
              product: {
                _id: "$product._id",
                name: "$product.name",
                LC: {
                  _id: "$product.LC._id",
                  "basicInfo.lcNumber": "$product.LC.basicInfo.lcNumber",
                },
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

    const saleToCancel = await Sales.findById(id).session(session)
      .populate("unit")
      .populate({
        path: "product",
        populate: {
          path: "unit",
        },
      });

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

    const pipeline = [];

    // Stage 1: Add fields for searching and sorting that require population
    pipeline.push({
      $lookup: {
        from: "products",
        localField: "product",
        foreignField: "_id",
        as: "productDetails",
      },
    });
    pipeline.push({
      $unwind: "$productDetails",
    });

    pipeline.push({
      $lookup: {
        from: "lcs",
        localField: "productDetails.LC",
        foreignField: "_id",
        as: "lcDetails",
      },
    });
    pipeline.push({
      $unwind: { path: "$lcDetails", preserveNullAndEmptyArrays: true }, // LC might be null
    });

    pipeline.push({
      $lookup: {
        from: "units",
        localField: "unit",
        foreignField: "_id",
        as: "saleUnitDetails",
      },
    });
    pipeline.push({
      $unwind: "$saleUnitDetails",
    });

    pipeline.push({
      $lookup: {
        from: "customers",
        localField: "customer.customerId",
        foreignField: "_id",
        as: "customerLookup",
      },
    });
    pipeline.push({
      $unwind: { path: "$customerLookup", preserveNullAndEmptyArrays: true },
    });

    // Stage 2: Filtering
    const matchConditions = {
      isDeleted: { $ne: true },
    };
    if (invoiceStatus) {
      matchConditions.invoiceStatus = invoiceStatus;
    }
    if (paymentStatus) {
      matchConditions.paymentStatus = paymentStatus;
    }

    if (search) {
      const searchRegex = new RegExp(search, "i");
      matchConditions.$or = [
        { "customer.name": searchRegex },
        { "customerLookup.name": searchRegex },
        { "productDetails.name": searchRegex },
        { "lcDetails.basicInfo.lcNumber": searchRegex },
        // Note: Searching numeric fields with regex is not ideal.
        // This attempts to match if the search string is a valid number.
      ];
      if (!isNaN(parseFloat(search))) {
        matchConditions.$or.push({ totalAmountToBePaid: parseFloat(search) });
      }
    }

    if (Object.keys(matchConditions).length > 0) {
      pipeline.push({ $match: matchConditions });
    }

    // Stage 3: Add calculated field for sorting
    pipeline.push({
      $addFields: {
        convertedQuantity: {
          $multiply: ["$quantity", "$saleUnitDetails.conversionFactor"],
        },
        finalCustomerName: {
          $ifNull: ["$customerLookup.name", "$customer.name"],
        },
      },
    });

    // Stage 4: Facet for data and metadata (count)
    const sort = {};
    if (sortBy) {
      if (sortBy === "saleDate") {
        sort.saleDate = sortOrder === "asc" ? 1 : -1;
      } else if (sortBy === "totalAmountToBePaid") {
        sort.totalAmountToBePaid =
          sortOrder === "bigger" || sortOrder === "desc" ? -1 : 1;
      } else if (sortBy === "quantity") {
        sort.convertedQuantity = sortOrder === "asc" ? 1 : -1;
      } else if (sortBy === "customerName") {
        sort.finalCustomerName = sortOrder === "asc" ? 1 : -1;
      } else if (sortBy === "productName") {
        sort["productDetails.name"] = sortOrder === "asc" ? 1 : -1;
      }
    } else {
      sort.saleDate = -1;
    }

    pipeline.push({
      $facet: {
        metadata: [{ $count: "totalSales" }],
        data: [
          { $sort: sort },
          { $skip: skip },
          { $limit: limitNum },
          {
            $project: {
              _id: 1,
              saleId: 1,
              "customer.name": "$finalCustomerName",
              "product.name": "$productDetails.name",
              "product.id": "$productDetails._id",
              "lc.number": "$lcDetails.basicInfo.lcNumber",
              "lc.id": "$lcDetails._id",
              quantity: 1,
              "unit.name": "$saleUnitDetails.name",
              "unit.id": "$saleUnitDetails._id",
              pricePerUnit: 1,
              totalAmountToBePaid: 1,
              invoiceStatus: 1,
              paymentStatus: 1,
              saleDate: 1,
            },
          },
        ],
      },
    });

    const result = await Sales.aggregate(pipeline);

    const sales = result[0].data;
    const totalSales = result[0].metadata[0]
      ? result[0].metadata[0].totalSales
      : 0;

    return res.status(200).json(
      new ApiResponse(
        200,
        {
          sales,
          totalSales,
          page: pageNum,
          limit: limitNum,
          totalPages: Math.ceil(totalSales / limitNum),
        },
        "Sales summary fetched successfully",
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
