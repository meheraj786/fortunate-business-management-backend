const Customer = require("../models/customer.model");
const Sales = require("../models/sales.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const mongoose = require("mongoose");
const Trash = require("../models/trash.model");

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
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A customer with the same ${field} '${value}' already exists.`
        )
      );
    }
    // Handle Mongoose validation errors
    if (error.name === "ValidationError") {
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
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A customer with the same ${field} '${value}' already exists.`
        )
      );
    }
    // Handle Mongoose validation errors
    if (error.name === "ValidationError") {
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

async function getCustomerById(req, res, next) {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ApiError(400, "Invalid customer ID"));
    }

    const pipeline = [
      { $match: { _id: new mongoose.Types.ObjectId(id) } },
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
            notInvoiced: {
              $size: {
                $filter: {
                  input: "$sales",
                  as: "s",
                  cond: { $eq: ["$$s.invoiceStatus", "Not-invoiced"] },
                },
              },
            },
            outstandingDues: {
              $sum: {
                $map: {
                  input: {
                    $filter: {
                      input: "$sales",
                      as: "s",
                      cond: { $eq: ["$$s.paymentStatus", "Due payment"] },
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
        },
      },
      {
        $project: {
          sales: 0, // Exclude the sales array from the final customer object
        },
      },
    ];

    const results = await Customer.aggregate(pipeline);

    if (results.length === 0) {
      return next(new ApiError(404, "Customer not found"));
    }

    const customerData = results[0];

    return res
      .status(200)
      .json(
        new ApiResponse(200, customerData, "Customer fetched successfully")
      );
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A customer with the same ${field} '${value}' already exists.`
        )
      );
    }
    // Handle Mongoose validation errors
    if (error.name === "ValidationError") {
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
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A customer with the same ${field} '${value}' already exists.`
        )
      );
    }
    // Handle Mongoose validation errors
    if (error.name === "ValidationError") {
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

async function deleteCustomer(req, res, next) {
  try {
    const { id } = req.params;
    const deleted = await Customer.findByIdAndUpdate(id, { isDeleted: true });

    if (!deleted) {
      return next(new ApiError(404, "Customer not found"));
    }

    await Trash.create({
      docId: deleted._id,
      model: "Customer",
      deletedBy: req.cookies?.userId || req.user?._id || null,
      deletedAt: new Date(),
    });

    return res
      .status(200)
      .json(
        new ApiResponse(200, deleted, "Customer moved to trash successfully")
      );
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A customer with the same ${field} '${value}' already exists.`
        )
      );
    }
    // Handle Mongoose validation errors
    if (error.name === "ValidationError") {
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

async function getCustomerStats(_, res, next) {
  try {
    const customers = await Customer.find({ isDeleted: false });

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
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A customer with the same ${field} '${value}' already exists.`
        )
      );
    }
    // Handle Mongoose validation errors
    if (error.name === "ValidationError") {
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
    const matchConditions = { isDeleted: false }; // <-- soft delete filter
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

    // const matchConditions = {};
    // if (status) {
    //   matchConditions.customerStatus = status;
    // }
    // if (customerType) {
    //   matchConditions.customerType = customerType;
    // }
    // if (search) {
    //   const searchRegex = { $regex: search, $options: "i" };
    //   matchConditions.$or = [
    //     { name: searchRegex },
    //     { phone: searchRegex },
    //     { customerId: searchRegex },
    //   ];
    // }
    if (Object.keys(matchConditions).length > 0) {
      pipeline.push({ $match: matchConditions });
    }

    // Stage 2: Lookup to join with Sales
    pipeline.push({
      $lookup: {
        from: "sales",
        let: { customerId: "$customerId" },
        pipeline: [
          {
            $match: {
              $expr: { $eq: ["$customer.customerId", "$$customerId"] },
              isDeleted: false, // <-- only active sales
            },
          },
        ],
        as: "sales",
      },
    });

    // pipeline.push({
    //   $lookup: {
    //     from: "sales",
    //     localField: "_id",
    //     foreignField: "customer.customerId",
    //     as: "sales",
    //   },
    // });

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
                $cond: [
                  { $eq: ["$$sale.invoiceStatus", "Not-invoiced"] },
                  1,
                  0,
                ],
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
                  {
                    $sum: {
                      $map: {
                        input: {
                          $filter: {
                            input: "$$dueSale.payments",
                            as: "p",
                            cond: { $eq: ["$$p.isDeleted", false] },
                          },
                        },
                        as: "p",
                        in: "$$p.amount",
                      },
                    },
                  },
                ],
              },
            },
          },
        },

        // totalDue: {
        //   $sum: {
        //     $map: {
        //       input: {
        //         $filter: {
        //           input: "$sales",
        //           as: "sale",
        //           cond: { $eq: ["$$sale.paymentStatus", "Due payment"] },
        //         },
        //       },
        //       as: "dueSale",
        //       in: {
        //         $subtract: [
        //           "$$dueSale.totalAmountToBePaid",
        //           { $sum: "$$dueSale.payments.amount" },
        //         ],
        //       },
        //     },
        //   },
        // },
      },
    });

    // Stage 4: Sorting
    const sortStage = {};
    const validSortBy = [
      "creditLimit",
      "joinDate",
      "totalPurchases",
      "totalSpent",
      "totalDue",
      "totalNotInvoiced",
      "lastPurchaseDate",
    ];
    if (validSortBy.includes(sortBy)) {
      sortStage[sortBy] = sortOrderNum;
    } else {
      sortStage.joinDate = -1; // Default sort
    }

    // Stage 5: Facet for pagination and total count
    pipeline.push({
      $facet: {
        customers: [
          { $sort: sortStage },
          { $skip: skip },
          { $limit: limitNum },
          {
            $project: {
              sales: 0, // Exclude the full sales array
            },
          },
        ],
        metadata: [{ $count: "totalItems" }],
      },
    });

    const result = await Customer.aggregate(pipeline);

    const customersSummary = result[0].customers;
    const totalCustomers =
      result[0].metadata.length > 0 ? result[0].metadata[0].totalItems : 0;

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
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A customer with the same ${field} '${value}' already exists.`
        )
      );
    }
    // Handle Mongoose validation errors
    if (error.name === "ValidationError") {
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

module.exports = {
  createCustomer,
  getAllCustomers,
  getCustomerById,
  updateCustomer,
  deleteCustomer,
  getCustomerStats,
  getCustomersSummary,
};
