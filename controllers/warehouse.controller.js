const Warehouse = require("../models/warehouse.model");
const Product = require("../models/product.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");

const createWarehouse = async (req, res, next) => {
  try {
    const { name, location } = req.body;

    const warehouse = await Warehouse.create({ name, location });

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
          `A warehouse with the same ${field} '${value}' already exists.`
        )
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
    next(new ApiError(500, error.message || "Something went wrong"));
  }
};

const getAllWarehouses = async (_, res, next) => {
  try {
    const results = await Warehouse.aggregate([
      {
        $match: {
          isDeleted: false,
        },
      },
      {
        $facet: {
          warehouses: [
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
                ],
                as: "products",
              },
            },
            // {
            //   $lookup: {
            //     from: "products",
            //     localField: "_id",
            //     foreignField: "warehouse",
            //     as: "products",
            //   },
            // },
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
              },
            },
          ],
          globalStats: [
            {
              $lookup: {
                from: "products",
                localField: "_id",
                foreignField: "warehouse",
                as: "products",
              },
            },
            { $unwind: "$products" },
            {
              $group: {
                _id: null,
                totalproducts: { $sum: 1 },
                "Total In-stock": {
                  $sum: {
                    $cond: [{ $gt: ["$products.quantity", 0] }, 1, 0],
                  },
                },
                "total lowstock": {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $gt: ["$products.quantity", 0] },
                          { $lt: ["$products.quantity", 20] },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
                "Total outofstock": {
                  $sum: {
                    $cond: [{ $eq: ["$products.quantity", 0] }, 1, 0],
                  },
                },
              },
            },
            { $project: { _id: 0 } },
          ],
        },
      },
    ]);

    const response = {
      warehouses: results[0].warehouses,
      stats: results[0].globalStats[0] || {
        totalproducts: 0,
        "Total In-stock": 0,
        "total lowstock": 0,
        "Total outofstock": 0,
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
          `A warehouse with the same ${field} '${value}' already exists.`
        )
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
    next(new ApiError(500, error.message || "Something went wrong"));
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
          localField: "_id",
          foreignField: "warehouse",
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
          `A warehouse with the same ${field} '${value}' already exists.`
        )
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
    next(new ApiError(500, error.message || "Something went wrong"));
  }
};

const updateWarehouse = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const warehouse = await Warehouse.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true,
    })
      .populate("manager")
      .populate("product");

    if (!warehouse) {
      return next(new ApiError(404, "Warehouse not found"));
    }

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
          `A warehouse with the same ${field} '${value}' already exists.`
        )
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
    next(new ApiError(500, error.message || "Something went wrong"));
  }
};

const deleteWarehouse = async (req, res, next) => {
  try {
    const { id } = req.params;
    const warehouse = await Warehouse.findById(id);

    if (!warehouse) {
      return next(new ApiError(404, "Warehouse not found"));
    }

    if (warehouse.product && warehouse.product.length > 0) {
      return next(
        new ApiError(
          400,
          "Cannot delete warehouse with associated products. Please move or delete them first."
        )
      );
    }

    await Warehouse.findByIdAndUpdate(id, { isDeleted: true });

    // move to trash
    await Trash.create({
      docId: id,
      model: "Warehouse",
      deletedBy: req.cookies?.userId || req.user?._id || null,
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
          `A warehouse with the same ${field} '${value}' already exists.`
        )
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
    next(new ApiError(500, error.message || "Something went wrong"));
  }
};

module.exports = {
  createWarehouse,
  getAllWarehouses,
  getWarehouseById,
  updateWarehouse,
  deleteWarehouse,
};
