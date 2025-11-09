const Customer = require("../models/customer.model");
const Sales = require("../models/sales.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const mongoose = require("mongoose");

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

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ApiError(400, "Invalid customer ID"));
    }

    const customer = await Customer.findById(id);

    if (!customer) {
      return next(new ApiError(404, "Customer not found"));
    }

    const statsPipeline = [
      {
        $match: { "customer.customerId": new mongoose.Types.ObjectId(id) },
      },
      {
        $group: {
          _id: "$customer.customerId",
          totalPurchases: { $sum: 1 },
          totalSpent: { $sum: "$totalAmountToBePaid" },
          notInvoiced: {
            $sum: {
              $cond: [{ $eq: ["$invoiceStatus", "Not-invoiced"] }, 1, 0],
            },
          },
          dueSales: {
            $push: {
              $cond: [
                { $eq: ["$paymentStatus", "Due payment"] },
                {
                  totalAmountToBePaid: "$totalAmountToBePaid",
                  payments: "$payments",
                },
                "$$REMOVE",
              ],
            },
          },
        },
      },
    ];

    const stats = await Sales.aggregate(statsPipeline);

    let outstandingDues = 0;
    if (stats.length > 0 && stats[0].dueSales.length > 0) {
      outstandingDues = stats[0].dueSales.reduce((totalDue, sale) => {
        const totalPaid = sale.payments.reduce(
          (acc, p) => acc + p.amount,
          0
        );
        return totalDue + (sale.totalAmountToBePaid - totalPaid);
      }, 0);
    }

    const customerData = {
      ...customer.toObject(),
      stats: {
        totalPurchases: stats.length > 0 ? stats[0].totalPurchases : 0,
        totalSpent: stats.length > 0 ? stats[0].totalSpent : 0,
        notInvoiced: stats.length > 0 ? stats[0].notInvoiced : 0,
        outstandingDues,
      },
    };

    return res
      .status(200)
      .json(
        new ApiResponse(200, customerData, "Customer fetched successfully")
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

async function getCustomersSummary(req, res, next) {
  try {
    const salesStats = await Sales.aggregate([
      {
        $match: { "customer.customerId": { $ne: null } },
      },
      {
        $group: {
          _id: "$customer.customerId",
          totalPurchases: { $sum: 1 },
          totalSpent: { $sum: "$totalAmountToBePaid" },
          totalNotInvoiced: {
            $sum: {
              $cond: [{ $eq: ["$invoiceStatus", "Not-invoiced"] }, 1, 0],
            },
          },
          lastPurchaseDate: { $max: "$saleDate" },
          dueSales: {
            $push: {
              $cond: [
                { $eq: ["$paymentStatus", "Due payment"] },
                {
                  totalAmountToBePaid: "$totalAmountToBePaid",
                  payments: "$payments",
                },
                "$$REMOVE",
              ],
            },
          },
        },
      },
    ]);

    const salesStatsMap = new Map(
      salesStats.map((stat) => [stat._id.toString(), stat])
    );

    const allCustomers = await Customer.find({}).lean();

    const customersSummary = allCustomers.map((customer) => {
      const stats = salesStatsMap.get(customer._id.toString());
      let totalDue = 0;

      if (stats && stats.dueSales.length > 0) {
        totalDue = stats.dueSales.reduce((total, sale) => {
          const totalPaid = sale.payments.reduce(
            (acc, p) => acc + p.amount,
            0
          );
          return total + (sale.totalAmountToBePaid - totalPaid);
        }, 0);
      }

      return {
        _id: customer._id,
        customerId: customer.customerId,
        name: customer.name,
        phone: customer.phone,
        billingAddress: customer.billingAddress,
        customerStatus: customer.customerStatus,
        creditLimit: customer.creditLimit,
        joinDate: customer.joinDate,
        customerType: customer.customerType,
        totalPurchases: stats ? stats.totalPurchases : 0,
        totalSpent: stats ? stats.totalSpent : 0,
        totalDue,
        totalNotInvoiced: stats ? stats.totalNotInvoiced : 0,
        lastPurchaseDate: stats ? stats.lastPurchaseDate : null,
      };
    });

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          customersSummary,
          "Customers summary fetched successfully"
        )
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
  getCustomersSummary,
};
