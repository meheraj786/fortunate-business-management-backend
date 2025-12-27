const Sales = require("../models/sales.model");
const Product = require("../models/product.model");
const Customer = require("../models/customer.model");
const Unit = require("../models/unit.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const Account = require("../models/account.model");
const DailyCash = require("../models/dailyCash.model");
const Trash = require("../models/trash.model"); // Added Trash Model
const mongoose = require("mongoose");
const Transaction = require("../models/transaction.model");

// Helper mapping for Account Types
const paymentMethodToAccountType = {
  "cash": "Cash",
  "bank": "Bank",
  "mobile-banking": "Mobile Banking"
};

/* ================= CREATE SALE ================= */
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
      if (match) lastSaleIdNumber = parseInt(match[1], 10);
    }

    const newSaleId = `SALE-${shortYear}-${(lastSaleIdNumber + 1).toString().padStart(6, "0")}`;
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

    const transformedPayments = originalPayments.map(p => ({
      ...p,
      method: p.method?.toLowerCase(),
      accountId: p.account || p.accountId,
    }));

    // Ensure we don't sell a deleted product
    const sellingProduct = await Product.findOne({ _id: productId, isDeleted: { $ne: true } }).session(session).populate('unit');
    if (!sellingProduct) throw new ApiError(400, "Product not found or has been deleted");

    const saleUnit = await Unit.findById(unit).session(session);
    if (!saleUnit) throw new ApiError(400, "Sale unit not found");

    const saleQuantityInBaseUnit = quantity * saleUnit.conversionFactor;
    const productStockInBaseUnit = sellingProduct.quantity * sellingProduct.unit.conversionFactor;

    if (productStockInBaseUnit < saleQuantityInBaseUnit) {
      throw new ApiError(400, "Not enough product in stock");
    }

    const quantityToDeductFromProduct = saleQuantityInBaseUnit / sellingProduct.unit.conversionFactor;

    const sale = new Sales({
      saleId: newSaleId,
      product: productId,
      customer: {
        name: customerInfo.name,
        phone: customerInfo.phone,
        address: customerInfo.address,
        customerId: customerInfo.customerId || null,
      },
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
      if (["bank", "mobile-banking", "cash"].includes(payment.method)) {
        const account = await Account.findById(payment.accountId).session(session);
        if (!account) throw new ApiError(404, `Account not found.`);

        const expectedAccountType = paymentMethodToAccountType[payment.method];
        if (account.accountType !== expectedAccountType) {
          throw new ApiError(400, `Payment method mismatch for account type.`);
        }

        const paymentDateNormalized = new Date(payment.date);
        paymentDateNormalized.setHours(0, 0, 0, 0);
        const dailyCash = await DailyCash.findOne({ date: paymentDateNormalized }).session(session);

        if (!dailyCash || dailyCash.status === "Closed") {
          throw new ApiError(400, `Daily cash is closed for ${paymentDateNormalized.toDateString()}.`);
        }

        account.balance += payment.amount;
        await account.save({ session });

        await Transaction.create([{
          accountId: account._id,
          date: payment.date,
          description: `Payment received for Sale: ${newSaleId} via ${payment.method}.`,
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

/* ================= GET ALL SALES (Filtered) ================= */
async function getAllSales(_, res, next) {
  try {
    const sales = await Sales.aggregate([
      { $match: { isDeleted: { $ne: true } } },
      { $lookup: { from: "products", localField: "product", foreignField: "_id", as: "product" } },
      { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
      { $lookup: { from: "lcs", localField: "product.LC", foreignField: "_id", as: "product.LC" } },
      { $unwind: { path: "$product.LC", preserveNullAndEmptyArrays: true } },
      { $lookup: { from: "units", localField: "product.unit", foreignField: "_id", as: "product.unit" } },
      { $unwind: { path: "$product.unit", preserveNullAndEmptyArrays: true } },
      { $lookup: { from: "customers", localField: "customer.customerId", foreignField: "_id", as: "customer.customerId" } },
      { $unwind: { path: "$customer.customerId", preserveNullAndEmptyArrays: true } },
      { $lookup: { from: "warehouses", localField: "warehouse", foreignField: "_id", as: "warehouse" } },
      { $unwind: { path: "$warehouse", preserveNullAndEmptyArrays: true } },
      { $lookup: { from: "categories", localField: "category", foreignField: "_id", as: "category" } },
      { $unwind: { path: "$category", preserveNullAndEmptyArrays: true } },
      { $unwind: { path: "$payments", preserveNullAndEmptyArrays: true } },
      { $lookup: { from: "accounts", localField: "payments.accountId", foreignField: "_id", as: "payments.accountId" } },
      { $unwind: { path: "$payments.accountId", preserveNullAndEmptyArrays: true } },
      { $group: { _id: "$_id", doc: { $first: "$$ROOT" }, payments: { $push: "$payments" } } },
      { $replaceRoot: { newRoot: { $mergeObjects: ["$doc", { payments: "$payments" }] } } },
      { $sort: { createdAt: -1 } }
    ]);

    return res.status(200).json(new ApiResponse(200, sales, "Sales fetched successfully"));
  } catch (error) {
    next(error);
  }
}

/* ================= GET SALE BY ID (Filtered) ================= */
async function getSaleById(req, res, next) {
  try {
    const { id } = req.params;
    const results = await Sales.aggregate([
      { $match: { _id: new mongoose.Types.ObjectId(id), isDeleted: { $ne: true } } },
      { $lookup: { from: "products", localField: "product", foreignField: "_id", as: "product" } },
      { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
      { $lookup: { from: "lcs", localField: "product.LC", foreignField: "_id", as: "product.LC" } },
      { $unwind: { path: "$product.LC", preserveNullAndEmptyArrays: true } },
      { $lookup: { from: "units", localField: "product.unit", foreignField: "_id", as: "product.unit" } },
      { $unwind: { path: "$product.unit", preserveNullAndEmptyArrays: true } },
      { $lookup: { from: "customers", localField: "customer.customerId", foreignField: "_id", as: "customer.customerId" } },
      { $unwind: { path: "$customer.customerId", preserveNullAndEmptyArrays: true } },
      { $lookup: { from: "warehouses", localField: "warehouse", foreignField: "_id", as: "warehouse" } },
      { $unwind: { path: "$warehouse", preserveNullAndEmptyArrays: true } },
      { $lookup: { from: "categories", localField: "category", foreignField: "_id", as: "category" } },
      { $unwind: { path: "$category", preserveNullAndEmptyArrays: true } },
      { $unwind: { path: "$payments", preserveNullAndEmptyArrays: true } },
      { $lookup: { from: "accounts", localField: "payments.accountId", foreignField: "_id", as: "payments.accountId" } },
      { $unwind: { path: "$payments.accountId", preserveNullAndEmptyArrays: true } },
      { $group: { _id: "$_id", doc: { $first: "$$ROOT" }, payments: { $push: "$payments" } } },
      { $replaceRoot: { newRoot: { $mergeObjects: ["$doc", { payments: "$payments" }] } } }
    ]);

    if (results.length === 0) return next(new ApiError(404, "Sale not found"));
    return res.status(200).json(new ApiResponse(200, results[0], "Sale fetched successfully"));
  } catch (error) {
    next(error);
  }
}

/* ================= UPDATE SALE (Filtered) ================= */
async function updateSale(req, res, next) {
  try {
    const { id } = req.params;
    const updateData = req.body;
    const sale = await Sales.findOne({ _id: id, isDeleted: { $ne: true } }).populate('unit').populate({ path: 'product', populate: { path: 'unit' }});
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

/* ================= SOFT DELETE SALE & REVERSAL ================= */
async function deleteSale(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const deletedBy = req.cookies?.userId || req.user?._id || null;

    // 1. Soft delete the sale
    const sale = await Sales.findOneAndUpdate(
      { _id: id, isDeleted: { $ne: true } },
      { isDeleted: true },
      { new: true, session }
    ).populate('unit').populate({ path: 'product', populate: { path: 'unit' }});

    if (!sale) throw new ApiError(404, "Sale not found");

    // 2. Create Trash Entry
    await Trash.create([{ docId: sale._id, model: "Sale", deletedBy }], { session });

    // 3. Restore Stock logic
    if (sale.product) {
      const restoreQty = (sale.quantity * sale.unit.conversionFactor) / sale.product.unit.conversionFactor;
      await Product.findByIdAndUpdate(sale.product._id, { $inc: { quantity: restoreQty } }, { session });
    }

    // 4. Reverse Financials
    for (const payment of sale.payments) {
      if (["bank", "mobile-banking", "cash"].includes(payment.method)) {
        const account = await Account.findById(payment.accountId).session(session);
        if (account) {
          account.balance -= payment.amount;
          await account.save({ session });
          
          await Transaction.create([{
            accountId: payment.accountId,
            date: new Date(),
            description: `Reversal: Sale ${sale.saleId} deleted.`,
            transactionType: "Expense",
            amount: payment.amount,
            source: "Auto",
            category: "Sales Reversal",
            reference: sale._id,
            referenceModel: "Sale",
          }], { session });
        }
      }
    }

    await session.commitTransaction();
    session.endSession();
    return res.status(200).json(new ApiResponse(200, sale, "Sale moved to trash successfully"));
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    next(error);
  }
}

/* ================= SALES SUMMARY (Filtered) ================= */
async function getSalesSummary(_, res, next) {
  try {
    const summary = await Sales.aggregate([
      { $match: { isDeleted: { $ne: true } } },
      {
        $group: {
          _id: null,
          totalSales: { $sum: "$totalAmount" },
          totalTransactions: { $sum: 1 },
          dailyData: { $push: { date: { $dateToString: { format: "%Y-%m-%d", date: "$saleDate" } }, amount: "$totalAmount" } },
        },
      },
      { $unwind: "$dailyData" },
      { $group: { _id: "$dailyData.date", dailyTotal: { $sum: "$dailyData.amount" }, totalSales: { $first: "$totalSales" }, totalTransactions: { $first: "$totalTransactions" } } },
      { $group: { _id: null, totalSales: { $first: "$totalSales" }, totalTransactions: { $first: "$totalTransactions" }, dailySummary: { $push: { k: "$_id", v: "$dailyTotal" } } } },
      { $project: { _id: 0, totalSales: 1, totalTransactions: 1, dailySummary: { $arrayToObject: "$dailySummary" } } },
    ]);

    const result = summary[0] || { totalSales: 0, totalTransactions: 0, dailySummary: {} };
    return res.status(200).json(new ApiResponse(200, result, "Sales summary fetched successfully"));
  } catch (error) {
    next(error);
  }
}

/* ================= PAGINATED SUMMARY (Filtered) ================= */
async function getPaginatedSalesSummary(req, res, next) {
  try {
    const { page = 1, limit = 10, invoiceStatus, paymentStatus, search, sortBy, sortOrder = "desc" } = req.query;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    const pipeline = [{ $match: { isDeleted: { $ne: true } } }];

    // Nested lookups
    pipeline.push(
      { $lookup: { from: "products", localField: "product", foreignField: "_id", as: "productDetails" } },
      { $unwind: "$productDetails" },
      { $lookup: { from: "lcs", localField: "productDetails.LC", foreignField: "_id", as: "lcDetails" } },
      { $unwind: { path: "$lcDetails", preserveNullAndEmptyArrays: true } },
      { $lookup: { from: "units", localField: "unit", foreignField: "_id", as: "saleUnitDetails" } },
      { $unwind: "$saleUnitDetails" },
      { $lookup: { from: "customers", localField: "customer.customerId", foreignField: "_id", as: "customerLookup" } },
      { $unwind: { path: "$customerLookup", preserveNullAndEmptyArrays: true } }
    );

    // Filter Logic
    const matchConditions = {};
    if (invoiceStatus) matchConditions.invoiceStatus = invoiceStatus;
    if (paymentStatus) matchConditions.paymentStatus = paymentStatus;

    if (search) {
      const searchRegex = new RegExp(search, "i");
      matchConditions.$or = [
        { "customer.name": searchRegex },
        { "customerLookup.name": searchRegex },
        { "productDetails.name": searchRegex },
        { "lcDetails.basicInfo.lcNumber": searchRegex },
      ];
    }
    
    if (Object.keys(matchConditions).length > 0) pipeline.push({ $match: matchConditions });

    const sort = {};
    sort[sortBy || "saleDate"] = sortOrder === "asc" ? 1 : -1;

    pipeline.push({
      $facet: {
        metadata: [{ $count: "totalSales" }],
        data: [
          { $sort: sort },
          { $skip: skip },
          { $limit: limitNum },
          {
            $project: {
              _id: 1, "customer.name": { $ifNull: ["$customerLookup.name", "$customer.name"] },
              "product.name": "$productDetails.name", "lc.number": "$lcDetails.basicInfo.lcNumber",
              quantity: 1, "unit.name": "$saleUnitDetails.name", pricePerUnit: 1,
              totalAmountToBePaid: 1, invoiceStatus: 1, paymentStatus: 1, saleDate: 1,
            },
          },
        ],
      },
    });

    const result = await Sales.aggregate(pipeline);
    const sales = result[0].data;
    const totalSales = result[0].metadata[0] ? result[0].metadata[0].totalSales : 0;
    
    return res.status(200).json(new ApiResponse(200, { sales, totalSales, page: pageNum, totalPages: Math.ceil(totalSales / limitNum) }, "Sales summary fetched"));
  } catch (error) {
    next(error);
  }
}

/* ================= STATUS COUNTS (Filtered) ================= */
async function getAll_invoices_status_count(req, res, next) {
  try {
    const stats = await Sales.aggregate([
      { $match: { isDeleted: { $ne: true } } },
      { $group: { _id: { inv: "$invoiceStatus", pay: "$paymentStatus" }, count: { $sum: 1 } } }
    ]);
    return res.status(200).json(new ApiResponse(200, stats, "Counts fetched"));
  } catch (error) {
    next(error);
  }
}

/* ================= PARTIAL PAYMENT (Filtered) ================= */
async function addPartialPayment(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const { amount, date, method, account: accountId } = req.body;
    const lowerMethod = method?.toLowerCase();

    const sale = await Sales.findOne({ _id: id, isDeleted: { $ne: true } }).session(session);
    if (!sale) throw new ApiError(404, "Sale not found");

    if (["bank", "mobile-banking", "cash"].includes(lowerMethod)) {
      const account = await Account.findById(accountId).session(session);
      const expectedType = paymentMethodToAccountType[lowerMethod];
      if (!account || account.accountType !== expectedType) {
        throw new ApiError(400, "Invalid account for payment method.");
      }

      account.balance += amount;
      await account.save({ session });

      await Transaction.create([{
        accountId, date, transactionType: "Income", amount, source: "Auto", category: "Sales",
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
    next(error);
  }
}

/* ================= CANCEL SALE (Filtered) ================= */
async function cancelSale(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const sale = await Sales.findOne({ _id: id, isDeleted: { $ne: true } }).session(session).populate('unit').populate({ path: 'product', populate: { path: 'unit' }});
    
    if (!sale || sale.invoiceStatus === "Cancelled") throw new ApiError(400, "Sale not found or already cancelled");

    for (const payment of sale.payments) {
      if (["bank", "mobile-banking", "cash"].includes(payment.method)) {
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
    return res.status(200).json(new ApiResponse(200, null, "Sale cancelled successfully"));
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    next(error);
  }
}

/* ================= GET BY CUSTOMER (Filtered) ================= */
async function getSalesByCustomerId(req, res, next) {
  try {
    const { customerId } = req.params;
    const sales = await Sales.find({ 
      "customer.customerId": customerId, 
      isDeleted: { $ne: true } 
    }).populate("product unit");
    
    return res.status(200).json(new ApiResponse(200, sales, "Customer sales fetched"));
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