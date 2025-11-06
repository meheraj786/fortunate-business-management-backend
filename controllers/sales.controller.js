const Sales = require("../models/sales.model");
const Product = require("../models/product.model");
const Customer = require("../models/customer.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");

async function createSale(req, res, next) {
  try {
    const {
      product,
      customer,
      quantity,
      price,
      discount = 0,
      due = 0,
      paymentStatus,
      unit,
      category,
      size,
      invoiceStatus,
      lcNumber,
    } = req.body;

    if (!product || !customer || !quantity || !price || !unit) {
      return next(new ApiError(400, "Required fields are missing"));
    }

    const transitionCustomer = await Customer.findById(customer);
    if (!transitionCustomer) {
      return next(new ApiError(400, "Customer not found"));
    }

    const sellingProduct = await Product.findById(product);
    if (!sellingProduct) {
      return next(new ApiError(400, "Product not found"));
    }

    if (sellingProduct.quantity < quantity) {
      return next(new ApiError(400, "Not enough product in stock"));
    }

    const totalAmount = quantity * price - discount;

    const sale = await Sales.create({
      product,
      customer,
      quantity,
      price,
      discount,
      due,
      paymentStatus,
      totalAmount,
      unit,
      category,
      size,
      invoiceStatus,
      lcNumber,
    });

    await Product.findByIdAndUpdate(
      product,
      { $inc: { quantity: -quantity } },
      { new: true }
    );

    await Customer.findByIdAndUpdate(customer, {
      $push: { transactions: sale._id },
    });

    return res
      .status(201)
      .json(new ApiResponse(201, sale, "Sale created successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function getAllSales(_, res, next) {
  try {
    const sales = await Sales.find()
      .populate("product", "name category size unit")
      .populate("customer", "name phone location");

    return res
      .status(200)
      .json(new ApiResponse(200, sales, "Sales fetched successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function getSaleById(req, res, next) {
  try {
    const { id } = req.params;
    const sale = await Sales.findById(id)
      .populate("product", "name category size unit")
      .populate("customer", "name phone location");

    if (!sale) return next(new ApiError(404, "Sale not found"));

    return res
      .status(200)
      .json(new ApiResponse(200, sale, "Sale fetched successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function updateSale(req, res, next) {
  try {
    const { id } = req.params;
    const updateData = req.body;

    // If quantity or price updated, recalculate totalAmount
    if (updateData.quantity || updateData.price || updateData.discount) {
      const existingSale = await Sales.findById(id);
      if (!existingSale)
        return next(new ApiError(404, "Sale not found for update"));

      const newQuantity = updateData.quantity ?? existingSale.quantity;
      const newPrice = updateData.price ?? existingSale.price;
      const newDiscount = updateData.discount ?? existingSale.discount;

      updateData.totalAmount = newQuantity * newPrice - newDiscount;
    }

    const updated = await Sales.findByIdAndUpdate(id, updateData, {
      new: true,
      runValidators: true,
    });

    if (!updated) return next(new ApiError(404, "Sale not found"));

    return res
      .status(200)
      .json(new ApiResponse(200, updated, "Sale updated successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function deleteSale(req, res, next) {
  try {
    const { id } = req.params;

    const deleted = await Sales.findByIdAndDelete(id);

    if (!deleted) return next(new ApiError(404, "Sale not found"));

    return res
      .status(200)
      .json(new ApiResponse(200, deleted, "Sale deleted successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function getSalesSummary(_, res, next) {
  try {
    const sales = await Sales.find();

    const totalSales = sales.reduce((acc, s) => acc + (s.totalAmount || 0), 0);
    const totalTransactions = sales.length;

    const dailySummary = {};
    sales.forEach((sale) => {
      const day = sale.date.toISOString().split("T")[0];
      if (!dailySummary[day]) dailySummary[day] = 0;
      dailySummary[day] += sale.totalAmount || 0;
    });

    return res.status(200).json(
      new ApiResponse(
        200,
        {
          totalSales,
          totalTransactions,
          dailySummary,
        },
        "Sales summary fetched successfully"
      )
    );
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

module.exports = {
  createSale,
  getAllSales,
  getSaleById,
  updateSale,
  deleteSale,
  getSalesSummary,
};
