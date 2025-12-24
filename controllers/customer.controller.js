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
    if (error instanceof ApiError) {
      return next(error);
    }
    next(new ApiError(500, error.message || "Something went wrong"));
  }
}

async function getAllCustomers(_, res, next) {
  try {
    const customers = await Customer.find();

    return res
      .status(200)
      .json(new ApiResponse(200, customers, "Customers fetched successfully"));
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    next(new ApiError(500, error.message || "Something went wrong"));
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
    if (error instanceof ApiError) {
      return next(error);
    }
    next(new ApiError(500, error.message || "Something went wrong"));
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
    if (error instanceof ApiError) {
      return next(error);
    }
    next(new ApiError(500, error.message || "Something went wrong"));
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
    if (error instanceof ApiError) {
      return next(error);
    }
    next(new ApiError(500, error.message || "Something went wrong"));
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
    if (error instanceof ApiError) {
      return next(error);
    }
    next(new ApiError(500, error.message || "Something went wrong"));
  }
}

async function getCustomersSummary(req, res, next) {
  try {
    const {
      page = 1,
      limit = 10,
      search,
      status,
      customerType,
      sortBy,
      sortOrder = "desc",
    } = req.query;

    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;
    const sortOrderNum = sortOrder === "asc" ? 1 : -1;

    // --- Aggregation Pipeline ---
    const pipeline = [];

    // Stage 1: Initial Filtering & Searching
    const matchConditions = {};
    if (status) {
      matchConditions.customerStatus = status;
    }
    if (customerType) {
      matchConditions.customerType = customerType;
    }
    if (search) {
      const searchRegex = { $regex: search, $options: "i" };
      matchConditions.$or = [
        { name: searchRegex },
        { phone: searchRegex },
        { customerId: searchRegex },
      ];
    }
    if (Object.keys(matchConditions).length > 0) {
      pipeline.push({ $match: matchConditions });
    }
    
    // Stage 2: Lookup to join with Sales
    pipeline.push({
      $lookup: {
        from: "sales",
        localField: "_id",
        foreignField: "customer.customerId",
        as: "sales",
      },
    });

    // Stage 3: Add fields to calculate summary stats
    pipeline.push({
      $addFields: {
        totalPurchases: { $size: "$sales" },
        totalSpent: { $sum: "$sales.totalAmountToBePaid" },
        lastPurchaseDate: { $max: "$sales.saleDate" },
        totalNotInvoiced: {
          $sum: {
            $map: {
              input: "$sales",
              as: "sale",
              in: {
                $cond: [{ $eq: ["$$sale.invoiceStatus", "Not-invoiced"] }, 1, 0],
              },
            },
          },
        },
        totalDue: {
          $sum: {
            $map: {
              input: {
                $filter: {
                  input: "$sales",
                  as: "sale",
                  cond: { $eq: ["$$sale.paymentStatus", "Due payment"] },
                },
              },
              as: "dueSale",
              in: {
                $subtract: [
                  "$$dueSale.totalAmountToBePaid",
                  { $sum: "$$dueSale.payments.amount" },
                ],
              },
            },
          },
        },
      },
    });

    // --- Create a parallel pipeline for total count ---
    const countPipeline = [...pipeline];
    countPipeline.push({ $count: "totalCustomers" });
    const totalResult = await Customer.aggregate(countPipeline);
    const totalCustomers = totalResult.length > 0 ? totalResult[0].totalCustomers : 0;
    
    // Stage 4: Sorting
    const sortStage = {};
    const validSortBy = [
      "creditLimit", "joinDate", "totalPurchases",
      "totalSpent", "totalDue", "totalNotInvoiced", "lastPurchaseDate"
    ];
    if (validSortBy.includes(sortBy)) {
      sortStage[sortBy] = sortOrderNum;
    } else {
      sortStage.joinDate = -1; // Default sort
    }
    pipeline.push({ $sort: sortStage });
    
    // Stage 5: Pagination
    pipeline.push({ $skip: skip }, { $limit: limitNum });

    // Stage 6: Final Projection
    pipeline.push({
      $project: {
        sales: 0, // Exclude the full sales array from the final output
      },
    });

    const customersSummary = await Customer.aggregate(pipeline);

    return res.status(200).json(
      new ApiResponse(
        200,
        {
          customers: customersSummary,
          totalPages: Math.ceil(totalCustomers / limitNum),
          currentPage: pageNum,
          totalItems: totalCustomers,
        },
        "Customers summary fetched successfully"
      )
    );
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    next(new ApiError(500, error.message || "Something went wrong"));
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
