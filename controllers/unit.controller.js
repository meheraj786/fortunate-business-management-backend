const Unit = require("../models/unit.model");
const Trash = require("../models/trash.model"); 
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");

/* ================= CREATE UNIT ================= */
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
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return next(new ApiError(409, `A unit with the ${field} already exists.`));
    }
    if (error.name === 'ValidationError') {
      return next(new ApiError(400, "Validation failed", error.errors));
    }
    next(new ApiError(500, error.message || "Something went wrong"));
  }
};

/* ================= GET ALL UNITS (Filtered) ================= */
exports.getUnits = async (_, res, next) => {
  try {
    const units = await Unit.find({ isDeleted: { $ne: true } }).sort({ name: 1 });
    
    res
      .status(200)
      .json(new ApiResponse(200, units, "Units fetched successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

/* ================= GET UNIT BY ID (Filtered) ================= */
exports.getUnitById = async (req, res, next) => {
  try {
    const { id } = req.params;
    
    const unit = await Unit.findOne({ _id: id, isDeleted: { $ne: true } });
    
    if (!unit) return next(new ApiError(404, "Unit not found"));

    res
      .status(200)
      .json(new ApiResponse(200, unit, "Unit fetched successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

/* ================= UPDATE UNIT (Filtered) ================= */
exports.updateUnit = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, type, conversionFactor } = req.body;

    const unit = await Unit.findOneAndUpdate(
      { _id: id, isDeleted: { $ne: true } },
      { 
        name: name?.trim(), 
        type: type?.trim(), 
        conversionFactor 
      },
      { new: true, runValidators: true }
    );

    if (!unit) return next(new ApiError(404, "Unit not found"));

    res
      .status(200)
      .json(new ApiResponse(200, unit, "Unit updated successfully"));
  } catch (error) {
    if (error.code === 11000) {
      return next(new ApiError(409, "A unit with this name already exists."));
    }
    next(new ApiError(500, error.message));
  }
};

/* ================= SOFT DELETE & TRASH ================= */
exports.deleteUnit = async (req, res, next) => {
  try {
    const { id } = req.params;
    const deletedBy = req.cookies?.userId || req.user?._id || null;

    const unit = await Unit.findOneAndUpdate(
      { _id: id, isDeleted: { $ne: true } },
      { isDeleted: true },
      { new: true }
    );

    if (!unit) return next(new ApiError(404, "Unit not found"));

    await Trash.create({
      docId: unit._id,
      model: "Unit",
      deletedBy,
    });

    res
      .status(200)
      .json(new ApiResponse(200, unit, "Unit moved to trash successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};