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
    const sales = await Sales.find()
      .populate({
        path: "product",
        select: "name category unit LC",
        populate: [
          { path: "LC", select: "basicInfo.lcNumber" },
          { path: "unit", select: "name type conversionFactor" }
        ]
      })
      .populate("customer.customerId", "name phone location")
      .populate("warehouse", "name")
      .populate("category", "name")
      .populate({ path: "payments.accountId", model: "Account" });

    return res.status(200).json(new ApiResponse(200, sales, "Sales fetched successfully"));
  } catch (error) {
    next(error);
  }
}

async function getSaleById(req, res, next) {
  try {
    const { id } = req.params;
    const sale = await Sales.findById(id)
      .populate({
        path: "product",
        select: "name category unit LC",
        populate: [
          { path: "LC", select: "basicInfo.lcNumber" },
          { path: "unit", select: "name type conversionFactor" }
        ]
      })
      .populate("customer.customerId", "name phone location")
      .populate("warehouse", "name")
      .populate("category", "name")
      .populate({ path: "payments.accountId", model: "Account" });

    if (!sale) return next(new ApiError(404, "Sale not found"));
    return res.status(200).json(new ApiResponse(200, sale, "Sale fetched successfully"));
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
    const deletedSale = await Sales.findByIdAndDelete(id, { session }).populate('unit').populate({ path: 'product', populate: { path: 'unit' }});
    if (!deletedSale) throw new ApiError(404, "Sale not found");

    if (deletedSale.product) {
      const restoreQty = (deletedSale.quantity * deletedSale.unit.conversionFactor) / deletedSale.product.unit.conversionFactor;
      await Product.findByIdAndUpdate(deletedSale.product._id, { $inc: { quantity: restoreQty } }, { session });
    }

    for (const payment of deletedSale.payments) {
      if (["bank", "mobile-banking", "cash"].includes(payment.method)) { // ✅ Lowercase check
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
    const sales = await Sales.find();
    const totalSales = sales.reduce((acc, s) => acc + (s.totalAmountToBePaid || 0), 0);
    return res.status(200).json(new ApiResponse(200, { totalSales, count: sales.length }, "Summary fetched"));
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
    next(error);
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
    const { page = 1, limit = 10, search } = req.query;
    const query = search ? { "customer.name": new RegExp(search, "i") } : {};
    const sales = await Sales.find(query)
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .populate("product unit");
    const count = await Sales.countDocuments(query);
    return res.status(200).json(new ApiResponse(200, { sales, totalPages: Math.ceil(count / limit), currentPage: page }, "Fetched"));
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