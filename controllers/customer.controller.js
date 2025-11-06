const Customer = require("../models/customer.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");

async function createCustomer(req, res, next) {
  try {
    const currentYear = new Date().getFullYear();
    const lastCustomer = await Customer.findOne({
      customerId: new RegExp(`^CUST-${currentYear}-`, "i"),
    }).sort({ customerId: -1 });

    let lastCustomerIdNumber = 0;
    if (lastCustomer && lastCustomer.customerId) {
      const match = lastCustomer.customerId.match(/(\d+)$/);
      if (match) {
        lastCustomerIdNumber = parseInt(match[1], 10);
      }
    }

    const newCustomerId = `CUST-${currentYear}-${(lastCustomerIdNumber + 1)
      .toString()
      .padStart(4, "0")}`;

    req.body.customerId = newCustomerId;

    const customer = await Customer.create(req.body);
    return res
      .status(201)
      .json(new ApiResponse(201, customer, "Customer created successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function getAllCustomers(_, res, next) {
  try {
    const customers = await Customer.find();

    return res
      .status(200)
      .json(new ApiResponse(200, customers, "Customers fetched successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function getCustomerById(req, res, next) {
  try {
    const { id } = req.params;

    const customer = await Customer.findById(id);

    if (!customer) {
      return next(new ApiError(404, "Customer not found"));
    }

    return res
      .status(200)
      .json(new ApiResponse(200, customer, "Customer fetched successfully"));
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
      .json(new ApiResponse(200, updated, "Customer updated successfully"));
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
      .json(new ApiResponse(200, deleted, "Customer deleted successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function getCustomerStats(_, res, next) {
  try {
    const customers = await Customer.find();

    const stats = customers.map((customer) => {
      return {
        id: customer._id,
        name: customer.name,
        phone: customer.phone,
      };
    });

    return res
      .status(200)
      .json(
        new ApiResponse(200, stats, "Customer statistics fetched successfully")
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
