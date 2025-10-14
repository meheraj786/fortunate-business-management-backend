const Warehouse = require("../models/warehouse.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");

const createWarehouse = async (req, res, next) => {
  try {
    const { name, location } = req.body;

    if (!name || !location) {
      return next(new ApiError(400, "Name and location are required"));
    }

    const warehouse = await Warehouse.create({ name, location });

    return res
      .status(201)
      .json(new ApiResponse(warehouse, "Warehouse created successfully"));
  } catch (error) {
    next(new ApiError(500, "Failed to create warehouse", [error.message]));
  }
};

const getAllWarehouses = async (_, res, next) => {
  try {
    const warehouses = await Warehouse.find()
      .populate("manager")
      .populate("product");

    return res
      .status(200)
      .json(new ApiResponse(warehouses, "Warehouses fetched successfully"));
  } catch (error) {
    next(new ApiError(500, "Failed to fetch warehouses", [error.message]));
  }
};

const getWarehouseById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const warehouse = await Warehouse.findById(id)
      .populate("manager")
      .populate("product");

    if (!warehouse) {
      return next(new ApiError(404, "Warehouse not found"));
    }

    return res
      .status(200)
      .json(new ApiResponse(warehouse, "Warehouse fetched successfully"));
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
      .json(new ApiResponse(warehouse, "Warehouse updated successfully"));
  } catch (error) {
    next(new ApiError(500, "Failed to update warehouse", [error.message]));
  }
};

const deleteWarehouse = async (req, res, next) => {
  try {
    const { id } = req.params;
    const warehouse = await Warehouse.findByIdAndDelete(id);

    if (!warehouse) {
      return next(new ApiError(404, "Warehouse not found"));
    }

    return res
      .status(200)
      .json(new ApiResponse({}, "Warehouse deleted successfully"));
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
