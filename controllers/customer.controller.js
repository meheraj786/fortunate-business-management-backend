const Customer = require("../models/customer.model");
const Sales = require("../models/sales.model");
const Trash = require("../models/trash.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const mongoose = require("mongoose");

/* ================= CREATE ================= */
async function createCustomer(req, res, next) {
  try {
    const currentYear = new Date().getFullYear();

    const lastCustomer = await Customer.findOne({
      customerId: new RegExp(`^CUST-${currentYear}-`, "i"),
    }).sort({ customerId: -1 });

    let lastCustomerIdNumber = 0;
    if (lastCustomer?.customerId) {
      const match = lastCustomer.customerId.match(/(\d+)$/);
      if (match) lastCustomerIdNumber = parseInt(match[1], 10);
    }

    req.body.customerId = `CUST-${currentYear}-${(lastCustomerIdNumber + 1)
      .toString()
      .padStart(4, "0")}`;

    const customer = await Customer.create(req.body);

    res
      .status(201)
      .json(new ApiResponse(201, customer, "Customer created successfully"));
  } catch (error) {
    next(error);
  }
}

/* ================= GET ALL ================= */
async function getAllCustomers(_, res, next) {
  try {
    const customers = await Customer.find({
      isDeleted: { $ne: true },
    });

    res
      .status(200)
      .json(new ApiResponse(200, customers, "Customers fetched successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

/* ================= GET BY ID ================= */
async function getCustomerById(req, res, next) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ApiError(400, "Invalid customer ID"));
    }

    const pipeline = [
      {
        $match: {
          _id: new mongoose.Types.ObjectId(id),
          isDeleted: { $ne: true },
        },
      },
      {
        $lookup: {
          from: "sales",
          localField: "_id",
          foreignField: "customer.customerId",
          as: "sales",
        },
      },
      {
        $addFields: {
          stats: {
            totalPurchases: { $size: "$sales" },
            totalSpent: { $sum: "$sales.totalAmountToBePaid" },
          },
        },
      },
      { $project: { sales: 0 } },
    ];

    const result = await Customer.aggregate(pipeline);

    if (!result.length) {
      return next(new ApiError(404, "Customer not found"));
    }

    res
      .status(200)
      .json(new ApiResponse(200, result[0], "Customer fetched successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

/* ================= UPDATE ================= */
async function updateCustomer(req, res, next) {
  try {
    const { id } = req.params;

    const updated = await Customer.findOneAndUpdate(
      { _id: id, isDeleted: { $ne: true } },
      req.body,
      { new: true, runValidators: true }
    );

    if (!updated) {
      return next(new ApiError(404, "Customer not found"));
    }

    res
      .status(200)
      .json(new ApiResponse(200, updated, "Customer updated successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

/* ================= SOFT DELETE ================= */
async function deleteCustomer(req, res, next) {
  try {
    const { id } = req.params;

    const deletedBy = req.cookies?.userId || req.user?._id || null;

    const customer = await Customer.findOneAndUpdate(
      { _id: id, isDeleted: { $ne: true } },
      { isDeleted: true },
      { new: true }
    );

    if (!customer) {
      return next(new ApiError(404, "Customer not found"));
    }

    // Move to trash
    await Trash.create({
      docId: customer._id,
      model: "Customer",
      deletedBy,
    });

    res
      .status(200)
      .json(
        new ApiResponse(200, customer, "Customer moved to trash successfully")
      );
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

/* ================= STATS ================= */
async function getCustomerStats(_, res, next) {
  try {
    const customers = await Customer.find({
      isDeleted: { $ne: true },
    });

    const stats = customers.map((c) => ({
      id: c._id,
      name: c.name,
      phone: c.phone,
    }));

    res
      .status(200)
      .json(new ApiResponse(200, stats, "Customer stats fetched"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

/* ================= SUMMARY ================= */
async function getCustomersSummary(req, res, next) {
  try {
    const { page = 1, limit = 10, search } = req.query;

    const skip = (page - 1) * limit;

    const match = {
      isDeleted: { $ne: true },
    };

    if (search) {
      match.$or = [
        { name: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
        { customerId: { $regex: search, $options: "i" } },
      ];
    }

    const pipeline = [
      { $match: match },
      {
        $lookup: {
          from: "sales",
          localField: "_id",
          foreignField: "customer.customerId",
          as: "sales",
        },
      },
      {
        $addFields: {
          totalPurchases: { $size: "$sales" },
          totalSpent: { $sum: "$sales.totalAmountToBePaid" },
        },
      },
      {
        $facet: {
          customers: [
            { $sort: { joinDate: -1 } },
            { $skip: skip },
            { $limit: Number(limit) },
            { $project: { sales: 0 } },
          ],
          meta: [{ $count: "total" }],
        },
      },
    ];

    const result = await Customer.aggregate(pipeline);

    res.status(200).json(
      new ApiResponse(200, {
        customers: result[0].customers,
        totalItems: result[0].meta[0]?.total || 0,
        currentPage: Number(page),
      })
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
