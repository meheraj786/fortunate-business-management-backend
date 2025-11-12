const Unit = require("../models/unit.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");

exports.createUnit = async (req, res, next) => {
  try {
    const { name, type, conversionFactor } = req.body;

    const validationErrors = [];
    if (!name)
      validationErrors.push({ field: "name", message: "Name is required" });
    if (!type)
      validationErrors.push({ field: "type", message: "Type is required" });
    if (!conversionFactor)
      validationErrors.push({
        field: "conversionFactor",
        message: "Conversion factor is required",
      });

    if (validationErrors.length > 0) {
      return next(new ApiError(400, "Validation failed", validationErrors));
    }

    const existing = await Unit.findOne({ name: name.trim() });
    if (existing) {
      return next(
        new ApiError(400, "Validation failed", [
          { field: "name", message: "Unit already exists" },
        ])
      );
    }

    const unit = await Unit.create({
      name: name.trim(),
      type: type.trim(),
      conversionFactor,
    });
    res
      .status(201)
      .json(new ApiResponse(201, unit, "Unit created successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

exports.getUnits = async (_, res, next) => {
  try {
    const units = await Unit.find().sort({ name: 1 });
    res
      .status(200)
      .json(new ApiResponse(200, units, "Units fetched successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
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
    next(new ApiError(500, error.message));
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
    next(new ApiError(500, error.message));
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
    next(new ApiError(500, error.message));
  }
};
