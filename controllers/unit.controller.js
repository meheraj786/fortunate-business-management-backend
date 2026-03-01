const Unit = require("../models/unit.model");
const Trash = require("../models/trash.model");
const Product = require("../models/product.model");
const Sales = require("../models/sales.model");
const LC = require("../models/lc.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const logger = require("../utils/logger");
const auditService = require("../services/audit.service");

/* ================= CREATE UNIT ================= */
exports.createUnit = async (req, res, next) => {
  try {
    const { name, type, conversionFactor } = req.body;

    // Add validation for conversionFactor
    if (conversionFactor <= 0) {
      return next(
        new ApiError(400, "Conversion factor must be greater than 0."),
      );
    }

    const unit = await Unit.create({
      name: name.trim(),
      type: type.trim(),
      conversionFactor,
      createdBy: req.user?._id || null,
    });

    auditService.log({
      action: "CREATE",
      module: "Unit",
      documentId: unit._id,
      userId: req.user?._id,
      description: `Created unit "${unit.name}" (${unit.type})`,
      req,
    });

    res
      .status(201)
      .json(new ApiResponse(201, unit, "Unit created successfully"));
  } catch (error) {
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return next(
        new ApiError(409, `A unit with the ${field} already exists.`),
      );
    }
    if (error.name === "ValidationError") {
      return next(new ApiError(400, "Validation failed", error.errors));
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

/* ================= GET ALL UNITS (Filtered) ================= */
exports.getUnits = async (_, res, next) => {
  try {
    const units = await Unit.find({ isDeleted: { $ne: true } }).sort({
      name: 1,
    }).lean();

    res
      .status(200)
      .json(new ApiResponse(200, units, "Units fetched successfully"));
  } catch (error) {
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

/* ================= GET UNIT BY ID (Filtered) ================= */
exports.getUnitById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const unit = await Unit.findOne({ _id: id, isDeleted: { $ne: true } }).lean();

    if (!unit) return next(new ApiError(404, "Unit not found"));

    res
      .status(200)
      .json(new ApiResponse(200, unit, "Unit fetched successfully"));
  } catch (error) {
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

/* ================= UPDATE UNIT (Filtered) ================= */
exports.updateUnit = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, type, conversionFactor } = req.body;

    // Add validation for conversionFactor if it's being updated
    if (
      conversionFactor !== undefined &&
      conversionFactor !== null &&
      conversionFactor <= 0
    ) {
      return next(
        new ApiError(400, "Conversion factor must be greater than 0."),
      );
    }

    const unit = await Unit.findOneAndUpdate(
      { _id: id, isDeleted: { $ne: true } },
      {
        name: name?.trim(),
        type: type?.trim(),
        conversionFactor,
        modifiedBy: req.user?._id || null,
      },
      { new: true, runValidators: true },
    );

    if (!unit) return next(new ApiError(404, "Unit not found"));

    auditService.log({
      action: "UPDATE",
      module: "Unit",
      documentId: unit._id,
      userId: req.user?._id,
      description: `Updated unit "${unit.name}"`,
      req,
    });

    res
      .status(200)
      .json(new ApiResponse(200, unit, "Unit updated successfully"));
  } catch (error) {
    if (error.code === 11000) {
      return next(new ApiError(409, "A unit with this name already exists."));
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

/* ================= SOFT DELETE & TRASH ================= */
exports.deleteUnit = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Check if the unit is being used by any active products
    const productInUse = await Product.findOne({
      unit: id,
      isDeleted: { $ne: true },
    });
    if (productInUse) {
      return next(
        new ApiError(
          400,
          `Cannot delete unit: it is in use by product "${productInUse.name}".`,
        ),
      );
    }

    // Check if the unit is being used by any active sales
    const saleInUse = await Sales.findOne({
      unit: id,
      isDeleted: { $ne: true },
    });
    if (saleInUse) {
      return next(
        new ApiError(
          400,
          `Cannot delete unit: it is in use by sale "${saleInUse.saleId}".`,
        ),
      );
    }

    // Check if the unit is being used by any active LCs
    const lcInUse = await LC.findOne({
      "productInfo.quantityUnit": id,
      isDeleted: { $ne: true },
    });
    if (lcInUse) {
      return next(
        new ApiError(
          400,
          `Cannot delete unit: it is in use by LC "${lcInUse.basicInfo.lcNumber}".`,
        ),
      );
    }

    const deletedBy = req.cookies?.userId || req.user?._id || null;

    const unit = await Unit.findOneAndUpdate(
      { _id: id, isDeleted: { $ne: true } },
      { isDeleted: true, deletedBy },
      { new: true },
    );

    if (!unit) return next(new ApiError(404, "Unit not found"));

    await Trash.create({
      docId: unit._id,
      model: "Unit",
      deletedBy,
    });

    auditService.log({
      action: "DELETE",
      module: "Unit",
      documentId: unit._id,
      userId: deletedBy,
      description: `Deleted unit "${unit.name}"`,
      req,
    });

    res
      .status(200)
      .json(new ApiResponse(200, unit, "Unit moved to trash successfully"));
  } catch (error) {
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
