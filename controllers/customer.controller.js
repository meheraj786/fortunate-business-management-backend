const Customer = require("../models/customer.model");
const Sales = require("../models/sales.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");

async function createCustomer(req, res, next) {
  try {
    const customer = await Customer.create(req.body);
    return res
      .status(201)
      .json(new ApiResponse(customer, "Customer created successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function getAllCustomers(req, res, next) {
  try {
    const customers = await Customer.find().populate({
      path: "transactions",
      select: "totalAmount date status",
    });

    return res
      .status(200)
      .json(new ApiResponse(customers, "Customers fetched successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function getCustomerById(req, res, next) {
  try {
    const { id } = req.params;

    const customer = await Customer.findById(id).populate({
      path: "transactions",
      select: "totalAmount date items status",
    });

    if (!customer) {
      return next(new ApiError(404, "Customer not found"));
    }

    const totalPurchased = customer.transactions.reduce(
      (acc, sale) => acc + sale.totalAmount,
      0
    );
    const lastPurchase = customer.transactions.sort(
      (a, b) => new Date(b.date) - new Date(a.date)
    )[0];

    const summary = {
      totalPurchased,
      lastPurchase: lastPurchase ? lastPurchase.date : null,
      totalTransactions: customer.transactions.length,
      averageOrderValue:
        customer.transactions.length > 0
          ? totalPurchased / customer.transactions.length
          : 0,
    };

    return res
      .status(200)
      .json(
        new ApiResponse(
          { ...customer.toObject(), transactionSummary: summary },
          "Customer fetched successfully"
        )
      );
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function updateCustomer(req, res, next) {
  try {
    const { id } = req.params;
    const updated = await Customer.findByIdAndUpdate(id, req.body, {
      new: true,
      runValidators: true,
    });

    if (!updated) {
      return next(new ApiError(404, "Customer not found"));
    }

    return res
      .status(200)
      .json(new ApiResponse(updated, "Customer updated successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function deleteCustomer(req, res, next) {
  try {
    const { id } = req.params;
    const deleted = await Customer.findByIdAndDelete(id);

    if (!deleted) {
      return next(new ApiError(404, "Customer not found"));
    }

    return res
      .status(200)
      .json(new ApiResponse(deleted, "Customer deleted successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function getCustomerStats(_, res, next) {
  try {
    const customers = await Customer.find().populate({
      path: "transactions",
      select: "totalAmount date",
    });

    const stats = customers.map((customer) => {
      const totalPurchased = customer.transactions.reduce(
        (acc, sale) => acc + sale.totalAmount,
        0
      );
      const lastPurchase = customer.transactions.sort(
        (a, b) => new Date(b.date) - new Date(a.date)
      )[0];

      return {
        id: customer._id,
        name: customer.name,
        phone: customer.phone,
        location: customer.location,
        totalPurchased,
        lastPurchase: lastPurchase ? lastPurchase.date : null,
      };
    });

    return res
      .status(200)
      .json(
        new ApiResponse(stats, "Customer statistics fetched successfully")
      );
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

module.exports = {
  createCustomer,
  getAllCustomers,
  getCustomerById,
  updateCustomer,
  deleteCustomer,
  getCustomerStats,
};
