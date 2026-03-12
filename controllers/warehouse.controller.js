const mongoose = require("mongoose");
const Warehouse = require("../models/warehouse.model");
const Product = require("../models/product.model");
const User = require("../models/user.model"); // Import User model
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const logger = require("../utils/logger");
const { now } = require("../utils/timezone.util");
const Trash = require("../models/trash.model");
const auditService = require("../services/audit.service");

const createWarehouse = async (req, res, next) => {
  try {
    const { name, location } = req.body;

    // Create warehouse with createdBy field
    const warehouse = await Warehouse.create({
      name,
      location,
      createdBy: req.user?._id || null,
    });

    // Automatically assign the newly created warehouse to the creator
    if (req.user && req.user._id) {
      const creator = await User.findById(req.user._id);
      if (creator) {
        creator.warehouse.push(warehouse._id);
        await creator.save({ validateBeforeSave: false }); // Skip validation for this save as only pushing ID
      }
    }

    auditService.log({
      action: "CREATE",
      module: "Warehouse",
      documentId: warehouse._id,
      userId: req.user?._id,
      description: `Created warehouse "${warehouse.name}"`,
      req,
    });

    return res
      .status(201)
      .json(new ApiResponse(201, warehouse, "Warehouse created successfully"));
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
          `A warehouse with the same ${field} '${value}' already exists.`,
        ),
      ); // Specific message for warehouse
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
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
};

const getAllWarehouses = async (req, res, next) => {
  try {
    // Pipeline for fetching warehouses and their individual stats
    const warehousePipeline = [
      {
        $match: {
          isDeleted: false,
        },
      },
      // Conditionally add match stage for non-SUPER_ADMIN users
      ...(req.user.roleName !== "SUPER_ADMIN"
        ? [
          {
            $match: {
              _id: {
                $in: req.user.warehouse.map(
                  (id) => new mongoose.Types.ObjectId(id),
                ),
              },
            },
          },
        ]
        : []),
      {
        $lookup: {
          from: "products",
          let: { warehouseId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$warehouse", "$$warehouseId"] },
                    { $eq: ["$isDeleted", false] },
                  ],
                },
              },
            },
            // Lookup unit for conversion
            {
              $lookup: {
                from: "units",
                localField: "unit",
                foreignField: "_id",
                as: "unit",
              },
            },
            {
              $unwind: {
                path: "$unit",
                preserveNullAndEmptyArrays: true,
              },
            },
            // Calculate weight in KG
            {
              $addFields: {
                weightInKg: {
                  $cond: {
                    if: { $eq: ["$unit.type", "Weight"] },
                    then: {
                      $divide: [
                        { $multiply: ["$quantity", "$unit.conversionFactor"] },
                        1000,
                      ],
                    },
                    else: 0,
                  },
                },
              },
            },
          ],
          as: "products",
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "manager",
          foreignField: "_id",
          as: "manager",
        },
      },
      {
        $addFields: {
          stats: {
            totalProducts: { $size: "$products" },
            totalQuantity: { $sum: "$products.weightInKg" }, // Sum of weight in KG
            totalInStock: {
              $size: {
                $filter: {
                  input: "$products",
                  as: "product",
                  cond: { $gt: ["$$product.quantity", 0] },
                },
              },
            },
            totalLowStock: {
              $size: {
                $filter: {
                  input: "$products",
                  as: "product",
                  cond: {
                    $and: [
                      { $gt: ["$$product.quantity", 0] },
                      { $lt: ["$$product.quantity", 20] },
                    ],
                  },
                },
              },
            },
            totalOutOfStock: {
              $size: {
                $filter: {
                  input: "$products",
                  as: "product",
                  cond: { $eq: ["$$product.quantity", 0] },
                },
              },
            },
          },
        },
      },
      {
        $project: {
          products: 0, // Exclude the full products array from the final warehouse object
        },
      },
    ];

    // Separate, efficient pipeline for calculating global stats across all products
    const globalStatsPipeline = [
      // Conditionally add match stage for non-SUPER_ADMIN users
      ...(req.user.roleName !== "SUPER_ADMIN"
        ? [
          {
            $match: {
              warehouse: {
                $in: req.user.warehouse.map(
                  (id) => new mongoose.Types.ObjectId(id),
                ),
              },
            },
          },
        ]
        : []),
      { $match: { isDeleted: false } }, // Filter for active products
      {
        $lookup: {
          from: "units",
          localField: "unit",
          foreignField: "_id",
          as: "unit",
        },
      },
      {
        $unwind: {
          path: "$unit",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $addFields: {
          weightInKg: {
            $cond: {
              if: { $eq: ["$unit.type", "Weight"] },
              then: {
                $divide: [
                  { $multiply: ["$quantity", "$unit.conversionFactor"] },
                  1000,
                ],
              },
              else: 0,
            },
          },
        },
      },
      {
        $group: {
          _id: null,
          totalProducts: { $sum: 1 },
          totalQuantity: { $sum: "$weightInKg" }, // Sum of weight in KG
          totalInStock: {
            $sum: { $cond: [{ $gt: ["$quantity", 0] }, 1, 0] },
          },
          totalLowStock: {
            $sum: {
              $cond: [
                {
                  $and: [{ $gt: ["$quantity", 0] }, { $lt: ["$quantity", 20] }],
                },
                1,
                0,
              ],
            },
          },
          totalOutOfStock: {
            $sum: { $cond: [{ $eq: ["$quantity", 0] }, 1, 0] },
          },
        },
      },
      { $project: { _id: 0 } },
    ];

    // Run both aggregations concurrently for better performance
    const [warehouses, globalStatsResult] = await Promise.all([
      Warehouse.aggregate(warehousePipeline),
      Product.aggregate(globalStatsPipeline),
    ]);

    // Combine the results into a single response
    const response = {
      warehouses: warehouses,
      stats: globalStatsResult[0] || {
        totalProducts: 0,
        totalQuantity: 0,
        totalInStock: 0,
        totalLowStock: 0,
        totalOutOfStock: 0,
      },
    };

    return res
      .status(200)
      .json(new ApiResponse(200, response, "Warehouses fetched successfully"));
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
          `A warehouse with the same ${field} '${value}' already exists.`,
        ),
      ); // Specific message for warehouse
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
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
};

const getWarehouseById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const mongoose = require("mongoose");

    const results = await Warehouse.aggregate([
      {
        $match: {
          _id: new mongoose.Types.ObjectId(id),
          isDeleted: false,
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "manager",
          foreignField: "_id",
          as: "manager",
        },
      },
      {
        $lookup: {
          from: "products",
          let: { warehouseId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$warehouse", "$$warehouseId"] },
                    { $eq: ["$isDeleted", false] }, // Filter for active products
                  ],
                },
              },
            },
          ],
          as: "products",
        },
      },
      {
        $addFields: {
          manager: { $arrayElemAt: ["$manager", 0] },
          stats: {
            totalProducts: { $size: "$products" },
            totalInStock: {
              $size: {
                $filter: {
                  input: "$products",
                  as: "product",
                  cond: { $gt: ["$$product.quantity", 0] },
                },
              },
            },
            totalLowStock: {
              $size: {
                $filter: {
                  input: "$products",
                  as: "product",
                  cond: {
                    $and: [
                      { $gt: ["$$product.quantity", 0] },
                      { $lt: ["$$product.quantity", 20] },
                    ],
                  },
                },
              },
            },
            totalStockOut: {
              $size: {
                $filter: {
                  input: "$products",
                  as: "product",
                  cond: { $eq: ["$$product.quantity", 0] },
                },
              },
            },
          },
        },
      },
      {
        $project: {
          products: 0,
          "manager.password": 0, // Ensure sensitive fields are not returned
        },
      },
    ]);

    if (!results.length) {
      return next(new ApiError(404, "Warehouse not found"));
    }

    const warehouse = results[0];

    return res
      .status(200)
      .json(new ApiResponse(200, warehouse, "Warehouse fetched successfully"));
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
          `A warehouse with the same ${field} '${value}' already exists.`,
        ),
      ); // Specific message for warehouse
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
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
};

const updateWarehouse = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Capture snapshot for audit diff
    const oldWarehouse = await Warehouse.findById(id).lean();

    const warehouse = await Warehouse.findByIdAndUpdate(
      id,
      { ...updates, modifiedBy: req.user?._id || null },
      {
        new: true,
        runValidators: true,
      },
    )
      .populate("manager")
      .populate("product");

    if (!warehouse) {
      return next(new ApiError(404, "Warehouse not found"));
    }

    auditService.log({
      action: "UPDATE",
      module: "Warehouse",
      documentId: warehouse._id,
      userId: req.user?._id,
      description: `Updated warehouse "${warehouse.name}"`,
      changes: auditService.diffChanges(oldWarehouse, warehouse, ["name", "location"]),
      req,
    });

    return res
      .status(200)
      .json(new ApiResponse(200, warehouse, "Warehouse updated successfully"));
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
          `A warehouse with the same ${field} '${value}' already exists.`,
        ),
      ); // Specific message for warehouse
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
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
};

const deleteWarehouse = async (req, res, next) => {
  try {
    const { id } = req.params;
    const warehouse = await Warehouse.findById(id);

    if (!warehouse) {
      return next(new ApiError(404, "Warehouse not found"));
    }

    // Check if any ACTIVE products are still in this warehouse
    const activeProduct = await Product.findOne({
      warehouse: id,
      isDeleted: { $ne: true },
    });
    if (activeProduct) {
      return next(
        new ApiError(
          400,
          `Cannot delete warehouse: it still contains active products like "${activeProduct.name}". Please move or delete them first.`,
        ),
      );
    }

    await Warehouse.findByIdAndUpdate(id, {
      isDeleted: true,
      deletedBy: req.user?._id || null,
    });

    // move to trash
    await Trash.create({
      docId: id,
      model: "Warehouse",
      deletedBy: req.user?._id || null,
      deletedAt: now(),
      metadata: { warehouseId: new mongoose.Types.ObjectId(id) },
    });

    auditService.log({
      action: "DELETE",
      module: "Warehouse",
      documentId: warehouse._id,
      userId: req.user?._id,
      description: `Deleted warehouse "${warehouse.name}"`,
      req,
    });

    return res
      .status(200)
      .json(new ApiResponse(200, {}, "Warehouse moved to trash successfully"));
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
          `A warehouse with the same ${field} '${value}' already exists.`,
        ),
      ); // Specific message for warehouse
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
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
};

module.exports = {
  createWarehouse,
  getAllWarehouses,
  getWarehouseById,
  updateWarehouse,
  deleteWarehouse,
};
