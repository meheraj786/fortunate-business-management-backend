const Unit = require("../models/unit.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");

exports.createUnit = async (req, res, next) => {
  try {
    const { name, type, conversionFactor } = req.body;

    const unit = await Unit.create({
      name: name.trim(),
      type: type.trim(),
      conversionFactor,
    });
    res
      .status(201)
      .json(new ApiResponse(201, unit, "Unit created successfully"));
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(new ApiError(409, `A unit with the ${field} '${value}' already exists.`)); // Specific message for unit
    }
    // Handle Mongoose validation errors
    if (error.name === 'ValidationError') {
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

exports.getUnits = async (_, res, next) => {
  try {
    const units = await Unit.find().sort({ name: 1 });
    res
      .status(200)
      .json(new ApiResponse(200, units, "Units fetched successfully"));
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(new ApiError(409, `A unit with the same ${field} '${value}' already exists.`)); // Specific message for unit
    }
    // Handle Mongoose validation errors
    if (error.name === 'ValidationError') {
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

exports.getUnitById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const unit = await Unit.findById(id);
    if (!unit) return next(new ApiError(404, "Unit not found"));

    res
      .status(200)
      .json(new ApiResponse(200, unit, "Unit fetched successfully"));
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(new ApiError(409, `A unit with the same ${field} '${value}' already exists.`)); // Specific message for unit
    }
    // Handle Mongoose validation errors
    if (error.name === 'ValidationError') {
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

exports.updateUnit = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, type, conversionFactor } = req.body;

    const unit = await Unit.findByIdAndUpdate(
      id,
      { name: name.trim(), type: type.trim(), conversionFactor },
      { new: true, runValidators: true }
    );

    if (!unit) return next(new ApiError(404, "Unit not found"));

    res
      .status(200)
      .json(new ApiResponse(200, unit, "Unit updated successfully"));
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(new ApiError(409, `A unit with the same ${field} '${value}' already exists.`)); // Specific message for unit
    }
    // Handle Mongoose validation errors
    if (error.name === 'ValidationError') {
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

exports.deleteUnit = async (req, res, next) => {
  try {
    const { id } = req.params;
    const unit = await Unit.findByIdAndDelete(id);
    if (!unit) return next(new ApiError(404, "Unit not found"));

    res
      .status(200)
      .json(new ApiResponse(200, unit, "Unit deleted successfully"));
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(new ApiError(409, `A unit with the same ${field} '${value}' already exists.`)); // Specific message for unit
    }
    // Handle Mongoose validation errors
    if (error.name === 'ValidationError') {
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
