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
      unit,
      category,
      size,
      invoiceStatus,
      lcNumber,
    } = req.body;

    if (!product || !customer || !quantity || !price || !unit) {
      return next(new ApiError(400, "Required fields are missing"));
    }

    const sale = await Sales.create({
      product,
      customer,
      quantity,
      price,
      unit,
      category,
      size,
      invoiceStatus,
      lcNumber,
    });

    return res
      .status(201)
      .json(new ApiResponse(sale, "Sale created successfully"));
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
      .json(new ApiResponse(sales, "Sales fetched successfully"));
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
      .json(new ApiResponse(sale, "Sale fetched successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}
async function updateSale(req, res, next) {
  try {
    const { id } = req.params;

    const updated = await Sales.findByIdAndUpdate(id, req.body, {
      new: true,
      runValidators: true,
    });

    if (!updated) return next(new ApiError(404, "Sale not found"));

    return res
      .status(200)
      .json(new ApiResponse(updated, "Sale updated successfully"));
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
      .json(new ApiResponse(deleted, "Sale deleted successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function getSalesSummary(_, res, next) {
  try {
    const sales = await Sales.find();

    const totalSales = sales.reduce((acc, sale) => acc + sale.totalAmount, 0);
    const totalTransactions = sales.length;

    const dailySummary = {};
    sales.forEach((sale) => {
      const day = sale.date.toISOString().split("T")[0];
      if (!dailySummary[day]) dailySummary[day] = 0;
      dailySummary[day] += sale.totalAmount;
    });

    return res.status(200).json(
      new ApiResponse(
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
