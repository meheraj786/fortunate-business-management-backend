const Sales = require("../models/sales.model");
const Product = require("../models/product.model");
const Customer = require("../models/customer.model");
const Unit = require("../models/unit.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const Account = require("../models/account.model");
const DailyCash = require("../models/dailyCash.model");
const mongoose = require("mongoose");
const Transaction = require("../models/transaction.model");
const Trash = require("../models/trash.model");

// Helper mapping for Account Types (DB values vs Method values)
const paymentMethodToAccountType = {
  "cash": "Cash",
  "bank": "Bank",
  "mobile-banking": "Mobile Banking"
};

async function createSale(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const currentYear = new Date().getFullYear();
    const shortYear = currentYear.toString().slice(-2);
    
    const lastSale = await Sales.findOne({
      saleId: new RegExp(`^SALE-${shortYear}-`, "i"),
    }).sort({ saleId: -1 });

    let lastSaleIdNumber = 0;
    if (lastSale && lastSale.saleId) {
      const match = lastSale.saleId.match(/(\d+)$/);
      if (match) {
        lastSaleIdNumber = parseInt(match[1], 10);
      }
    }

    const newSaleId = `SALE-${shortYear}-${(lastSaleIdNumber + 1)
      .toString()
      .padStart(6, "0")}`;

    req.body.saleId = newSaleId;

    const {
      product: productId,
      customer: customerInfo,
      warehouse,
      category,
      quantity,
      unit,
      pricePerUnit,
      costs = [],
      discount = 0,
      invoiceStatus,
      paymentStatus,
      payments: originalPayments = [],
      notes,
      saleDate,
    } = req.body;

    if (customerInfo && customerInfo.customerId) {
      const customer = await Customer.findById(customerInfo.customerId).session(
        session
      );
      if (!customer) {
        throw new ApiError(404, "Customer specified for credit check not found.");
      }

      const sales = await Sales.find({
        "customer.customerId": customer._id,
        isDeleted: false,
      }).session(session);
      let outstandingDues = 0;
      sales.forEach((sale) => {
        const totalPaid = sale.payments.reduce((acc, p) => acc + p.amount, 0);
        const due = sale.totalAmountToBePaid - totalPaid;
        if (due > 0) {
          outstandingDues += due;
        }
      });

      const costsTotal = costs.reduce((acc, cost) => acc + cost.amount, 0);
      const totalAmountToBePaidForNewSale =
        quantity * pricePerUnit + costsTotal - discount;
      const totalPaidForNewSale = originalPayments.reduce(
        (acc, p) => acc + p.amount,
        0
      );
      const newSaleDue = totalAmountToBePaidForNewSale - totalPaidForNewSale;

      if (newSaleDue > 0) {
        if (customer.creditLimit > 0) {
          if (outstandingDues + newSaleDue > customer.creditLimit) {
            throw new ApiError(400, `Credit limit of ${customer.creditLimit} exceeded.`);
          }
        } else {
          throw new ApiError(
            400,
            `This customer has no credit limit. Full payment is required.`
          );
        }
      }
    }

    // Transform payments to ensure lowercase methods and correct accountId
    const transformedPayments = originalPayments.map(p => ({
      ...p,
      method: p.method?.toLowerCase(), // ✅ Standardized to lowercase
      accountId: p.account || p.accountId,
      account: undefined
    }));

    const validationErrors = [];
    if (!productId) validationErrors.push({ field: "product", message: "Product ID is required" });
    if (!customerInfo || !customerInfo.name) validationErrors.push({ field: "customer.name", message: "Customer name is required" });
    if (!quantity) validationErrors.push({ field: "quantity", message: "Quantity is required" });

    if (validationErrors.length > 0) {
      throw new ApiError(400, validationErrors[0].message, validationErrors);
    }

    const sellingProduct = await Product.findById(productId).session(session).populate('unit');
    if (!sellingProduct) throw new ApiError(400, "Product not found");

    const saleUnit = await Unit.findById(unit).session(session);
    if (!saleUnit) throw new ApiError(400, "Sale unit not found");

    const saleQuantityInBaseUnit = quantity * saleUnit.conversionFactor;
    const productStockInBaseUnit = sellingProduct.quantity * sellingProduct.unit.conversionFactor;

    if (productStockInBaseUnit < saleQuantityInBaseUnit) {
      throw new ApiError(400, "Not enough product in stock");
    }

    const quantityToDeductFromProduct = saleQuantityInBaseUnit / sellingProduct.unit.conversionFactor;

    const finalCustomerInfo = {
      name: customerInfo.name,
      phone: customerInfo.phone,
      address: customerInfo.address,
      customerId: customerInfo.customerId || null,
    };

    const sale = new Sales({
      saleId: req.body.saleId,
      product: productId,
      customer: finalCustomerInfo,
      warehouse,
      category,
      quantity,
      unit,
      pricePerUnit,
      costs,
      discount,
      invoiceStatus,
      paymentStatus,
      payments: transformedPayments,
      notes,
      saleDate,
    });

    for (const payment of transformedPayments) {
      if (["bank", "mobile-banking", "cash"].includes(payment.method)) { // ✅ Lowercase check
        if (!payment.accountId) {
          throw new ApiError(400, `Account ID is required for ${payment.method} payment.`);
        }
        const account = await Account.findById(payment.accountId).session(session);
        if (!account) throw new ApiError(404, `Account not found.`);

        const expectedAccountType = paymentMethodToAccountType[payment.method];
        if (account.accountType !== expectedAccountType) {
          throw new ApiError(400, `Payment method '${payment.method}' requires a '${expectedAccountType}' account.`);
        }

        account.balance += payment.amount;
        await account.save({ session });

        const paymentDateNormalized = new Date(payment.date);
        paymentDateNormalized.setHours(0, 0, 0, 0);
        const dailyCash = await DailyCash.findOne({ date: paymentDateNormalized }).session(session);

        if (!dailyCash || dailyCash.status === "Closed") {
          throw new ApiError(400, `Daily cash is closed for ${paymentDateNormalized.toDateString()}.`);
        }

        await Transaction.create([{
          accountId: account._id,
          date: payment.date,
          description: `Payment received for Sale: ${req.body.saleId} via ${payment.method}.`,
          transactionType: "Income",
          amount: payment.amount,
          name: "Sales Payment",
          source: "Auto",
          category: "Sales",
          paymentMethod: payment.method,
          reference: sale._id,
          referenceModel: "Sale",
        }], { session });
      }
    }

    await sale.save({ session });

    // Deduct Stock
    await Product.findByIdAndUpdate(productId, { $inc: { quantity: -quantityToDeductFromProduct } }, { session });

    await session.commitTransaction();
    session.endSession();
    return res.status(201).json(new ApiResponse(201, sale, "Sale created successfully"));
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    next(error);
  }
}

async function getAllSales(_, res, next) {
  try {
    const sales = await Sales.aggregate([
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

    return res.status(200).json(new ApiResponse(200, sales, "Sales fetched successfully"));
  } catch (error) {
    next(error);
  }
}

async function getSaleById(req, res, next) {
  try {
    const { id } = req.params;

    const results = await Sales.aggregate([
      { $match: { _id: new mongoose.Types.ObjectId(id) } },
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

    if (results.length === 0) {
      return next(new ApiError(404, "Sale not found"));
    }
    
    const sale = results[0];

    return res
      .status(200)
      .json(new ApiResponse(200, sale, "Sale fetched successfully"));
  } catch (error) {
    next(error);
  }
}

async function updateSale(req, res, next) {
  try {
    const { id } = req.params;
    const updateData = req.body;
    const sale = await Sales.findById(id).populate('unit').populate({ path: 'product', populate: { path: 'unit' }});
    if (!sale) return next(new ApiError(404, "Sale not found"));

    if (updateData.quantity && updateData.quantity !== sale.quantity) {
      const product = sale.product;
      const oldBaseQty = sale.quantity * sale.unit.conversionFactor;
      const newBaseQty = updateData.quantity * sale.unit.conversionFactor;
      const diffInProductUnit = (newBaseQty - oldBaseQty) / product.unit.conversionFactor;

      if (diffInProductUnit > 0 && product.quantity < diffInProductUnit) {
        return next(new ApiError(400, "Not enough stock for increase"));
      }
      await Product.findByIdAndUpdate(product._id, { $inc: { quantity: -diffInProductUnit } });
    }

    Object.assign(sale, updateData);
    const updatedSale = await sale.save();
    return res.status(200).json(new ApiResponse(200, updatedSale, "Sale updated successfully"));
  } catch (error) {
    next(error);
  }
}

async function deleteSale(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    // const deletedSale = await Sales.findByIdAndDelete(id, { session }).populate('unit').populate({ path: 'product', populate: { path: 'unit' }});
    const deletedSale = await Sales.findByIdAndUpdate(id, { isDeleted: true }, { session }).populate('unit').populate({ path: 'product', populate: { path: 'unit' }});
    if (!deletedSale) throw new ApiError(404, "Sale not found");

    if (deletedSale.product) {
      const restoreQty = (deletedSale.quantity * deletedSale.unit.conversionFactor) / deletedSale.product.unit.conversionFactor;
      await Product.findByIdAndUpdate(deletedSale.product._id, { $inc: { quantity: restoreQty } }, { session });
    }

    for (const payment of deletedSale.payments) {
      if (["bank", "mobile-banking", "cash"].includes(payment.method)) { 
        const account = await Account.findById(payment.accountId).session(session);
        if (account) {
          account.balance -= payment.amount;
          await account.save({ session });
          await Transaction.create([{
            accountId: payment.accountId,
            date: new Date(),
            description: `Reversal of Sale: ${deletedSale.saleId}`,
            transactionType: "Expense",
            amount: payment.amount,
            source: "Auto",
            category: "Sales Reversal",
            reference: deletedSale._id,
            referenceModel: "Sale",
          }], { session });
        }
      }
    }

    await Trash.create([{ docId: deletedSale._id, deletedBy: req?.user._id, deletedAt: new Date(), model: "Sale" }], { session });

    await session.commitTransaction();
    session.endSession();
    return res.status(200).json(new ApiResponse(200, deletedSale, "Sale deleted successfully"));
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    next(error);
  }
}

async function getSalesSummary(_, res, next) {
  try {
    const summary = await Sales.aggregate([
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
    next(error);
  }
}

async function getAll_invoices_status_count(req, res, next) {
  try {
    const stats = await Sales.aggregate([{ $group: { _id: { inv: "$invoiceStatus", pay: "$paymentStatus" }, count: { $sum: 1 } } }]);
    return res.status(200).json(new ApiResponse(200, stats, "Counts fetched"));
  } catch (error) {
    next(error);
  }
}

async function addPartialPayment(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const { amount, date, method, account: accountId } = req.body;
    const lowerMethod = method?.toLowerCase(); // ✅ Standardize

    const sale = await Sales.findById(id).session(session);
    if (!sale) throw new ApiError(404, "Sale not found");

    if (["bank", "mobile-banking", "cash"].includes(lowerMethod)) { // ✅ Lowercase check
      const account = await Account.findById(accountId).session(session);
      const expectedType = paymentMethodToAccountType[lowerMethod];
      if (account.accountType !== expectedType) {
        throw new ApiError(400, `Method ${lowerMethod} needs ${expectedType} account.`);
      }

      account.balance += amount;
      await account.save({ session });

      await Transaction.create([{
        accountId, date,
        description: `Partial payment for ${sale.saleId} via ${lowerMethod}`,
        transactionType: "Income",
        amount, source: "Auto", category: "Sales",
        reference: sale._id, referenceModel: "Sale",
      }], { session });
    }

    sale.payments.push({ amount, date, method: lowerMethod, accountId });
    await sale.save({ session });
    await session.commitTransaction();
    session.endSession();
    return res.status(200).json(new ApiResponse(200, sale, "Payment added"));
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
      return next(new ApiError(409, `A sale with the same ${field} '${value}' already exists.`)); // Generic message for sales
    }
    // Handle Mongoose validation errors
    if (error.name === 'ValidationError') {
      const firstErrorField = Object.keys(error.errors)[0];
      let userFriendlyMessage = "Validation failed.";

      if (firstErrorField) {
        userFriendlyMessage = `The field ${firstErrorField} is required.`;
      }
      return next(new ApiError(400, userFriendlyMessage, error.errors));
    }
    next(new ApiError(500, error.message || "An internal server error occurred while adding partial payment."));
  }
}

async function getSalesByCustomerId(req, res, next) {
  try {
    const { customerId } = req.params;
    const { 
      invoiceStatus, 
      paymentStatus, 
      page = 1, 
      limit = 10 
    } = req.query;

    if (!mongoose.Types.ObjectId.isValid(customerId)) {
      return next(new ApiError(400, "Invalid customer ID"));
    }
    
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;

    const pipeline = [];

    // Stage 1: Match by customer and other filters
    const matchQuery = { "customer.customerId": new mongoose.Types.ObjectId(customerId) };
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
          { $unwind: { path: "$product.LC", preserveNullAndEmptyArrays: true } },
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

    const totalDocs = salesResult.totalDocs.length > 0 ? salesResult.totalDocs[0].count : 0;
    const totalPages = Math.ceil(totalDocs / limitNum);

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          {
            sales: salesResult.docs,
            totalPages: totalPages,
            currentPage: pageNum,
            totalItems: totalDocs,
          },
          "Customer sales fetched successfully"
        )
      );
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(new ApiError(409, `A document with the same ${field} '${value}' already exists.`)); // Generic message
    }
    // Handle Mongoose validation errors
    if (error.name === 'ValidationError') {
      const firstErrorField = Object.keys(error.errors)[0];
      let userFriendlyMessage = "Validation failed.";

      if (firstErrorField) {
        userFriendlyMessage = `The field ${firstErrorField} is required.`;
      }
      return next(new ApiError(400, userFriendlyMessage, error.errors));
    }
    next(new ApiError(500, error.message || "Something went wrong"));
  }
}

async function cancelSale(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const sale = await Sales.findById(id).session(session).populate('unit').populate({ path: 'product', populate: { path: 'unit' }});
    if (!sale || sale.invoiceStatus === "Cancelled") throw new ApiError(400, "Sale already cancelled or not found");

    for (const payment of sale.payments) {
      if (["bank", "mobile-banking", "cash"].includes(payment.method)) { // ✅ Lowercase check
        const account = await Account.findById(payment.accountId).session(session);
        if (account) {
          account.balance -= payment.amount;
          await account.save({ session });
        }
      }
    }

    if (sale.product) {
      const restoreQty = (sale.quantity * sale.unit.conversionFactor) / sale.product.unit.conversionFactor;
      await Product.findByIdAndUpdate(sale.product._id, { $inc: { quantity: restoreQty } }, { session });
    }

    sale.invoiceStatus = "Cancelled";
    await sale.save({ session });
    await session.commitTransaction();
    session.endSession();
    return res.status(200).json(new ApiResponse(200, null, "Sale cancelled"));
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    next(error);
  }
}

async function getSalesByCustomerId(req, res, next) {
  try {
    const { customerId } = req.params;
    const sales = await Sales.find({ "customer.customerId": customerId }).populate("product unit");
    return res.status(200).json(new ApiResponse(200, sales, "Customer sales fetched"));
  } catch (error) {
    next(error);
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
    const matchConditions = {};
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
        sort.totalAmountToBePaid = sortOrder === "bigger" ? -1 : 1;
      } else if (sortBy === "quantity") {
        sort.convertedQuantity = sortOrder === "asc" ? 1 : -1;
      } else if (sortBy === "customerName") {
        sort.finalCustomerName = sortOrder === "asc" ? 1 : -1;
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
    const totalSales = result[0].metadata[0] ? result[0].metadata[0].totalSales : 0;
    
    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          {
            sales,
            totalSales,
            page: pageNum,
            limit: limitNum,
            totalPages: Math.ceil(totalSales / limitNum),
          },
          "Sales summary fetched successfully"
        )
      );
  } catch (error) {
    next(error);
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