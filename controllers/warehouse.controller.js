const Warehouse = require("../models/warehouse.model");
const Product = require("../models/product.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");

const createWarehouse = async (req, res, next) => {
  try {
    const { name, location } = req.body;

    const validationErrors = [];
    if (!name)
      validationErrors.push({ field: "name", message: "Name is required" });
    if (!location)
      validationErrors.push({
        field: "location",
        message: "Location is required",
      });

    if (validationErrors.length > 0) {
      return next(new ApiError(400, "Validation failed", validationErrors));
    }

    const warehouse = await Warehouse.create({ name, location });

    return res
      .status(201)
      .json(new ApiResponse(201, warehouse, "Warehouse created successfully"));
  } catch (error) {
    next(new ApiError(500, "Failed to create warehouse", [error.message]));
  }
};

const getAllWarehouses = async (_, res, next) => {
  try {
    const warehouses = await Warehouse.aggregate([
      {
        $lookup: {
          from: "products",
          localField: "_id",
          foreignField: "warehouse",
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
    ]);

    return res
      .status(200)
      .json(
        new ApiResponse(200, warehouses, "Warehouses fetched successfully")
      );
  } catch (error) {
    next(new ApiError(500, "Failed to fetch warehouses", [error.message]));
  }
};

const getWarehouseById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const warehouse = await Warehouse.findById(id).populate("manager");

    if (!warehouse) {
      return next(new ApiError(404, "Warehouse not found"));
    }

    const stats = await Product.getInventoryStats(id);

    const response = {
      _id: warehouse._id,
      name: warehouse.name,
      location: warehouse.location,
      manager: warehouse.manager,
      stats: {
        totalProducts: stats.totalProductsCount,
        totalInStock: stats.inStockProductsCount,
        totalLowStock: stats.lowStockProductsCount,
        totalStockOut: stats.outOfStockProductsCount,
      },
    };

    return res
      .status(200)
      .json(new ApiResponse(200, response, "Warehouse fetched successfully"));
  } catch (error) {
    next(new ApiError(500, "Failed to fetch warehouse", [error.message]));
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
    next(new ApiError(500, "Failed to update warehouse", [error.message]));
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

    await Warehouse.findByIdAndDelete(id);

    return res
      .status(200)
      .json(new ApiResponse(200, {}, "Warehouse deleted successfully"));
  } catch (error) {
    next(new ApiError(500, "Failed to delete warehouse", [error.message]));
  }
};

module.exports = {
  createWarehouse,
  getAllWarehouses,
  getWarehouseById,
  updateWarehouse,
  deleteWarehouse,
};
