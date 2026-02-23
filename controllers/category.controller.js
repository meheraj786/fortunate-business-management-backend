const Category = require("../models/category.model");
const Trash = require("../models/trash.model");
const Product = require("../models/product.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const { now } = require("../utils/timezone.util");
const logger = require("../utils/logger");
const auditService = require("../services/audit.service");

/* ================= CREATE ================= */
exports.createCategory = async (req, res, next) => {
  try {
    const { name, description } = req.body;

    const category = await Category.create({
      name: name.trim(),
      description,
      createdBy: req.user?._id || null,
    });

    auditService.log({
      action: "CREATE",
      module: "Category",
      documentId: category._id,
      userId: req.user?._id,
      description: `Created category "${category.name}"`,
      req,
    });

    res
      .status(201)
      .json(new ApiResponse(201, category, "Category created successfully"));
  } catch (error) {
    if (error instanceof ApiError) return next(error);

    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A category with the ${field} '${value}' already exists.`,
        ),
      );
    }

    if (error.name === "ValidationError") {
      const firstErrorField = Object.keys(error.errors)[0];
      const userFriendlyMessage = error.errors[firstErrorField].message;
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

/* ================= GET ALL ================= */
exports.getCategories = async (_, res, next) => {
  try {
    const categories = await Category.find({
      isDeleted: { $ne: true },
    }).sort({ name: 1 });

    res
      .status(200)
      .json(
        new ApiResponse(200, categories, "Categories fetched successfully"),
      );
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

/* ================= GET BY ID ================= */
exports.getCategoryById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const category = await Category.findOne({
      _id: id,
      isDeleted: { $ne: true },
    });

    if (!category) return next(new ApiError(404, "Category not found"));

    res
      .status(200)
      .json(new ApiResponse(200, category, "Category fetched successfully"));
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

/* ================= UPDATE ================= */
exports.updateCategory = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, description } = req.body;

    const category = await Category.findOneAndUpdate(
      { _id: id, isDeleted: { $ne: true } },
      { name: name.trim(), description, modifiedBy: req.user?._id || null },
      { new: true, runValidators: true },
    );

    if (!category) return next(new ApiError(404, "Category not found"));

    auditService.log({
      action: "UPDATE",
      module: "Category",
      documentId: category._id,
      userId: req.user?._id,
      description: `Updated category "${category.name}"`,
      req,
    });

    res
      .status(200)
      .json(new ApiResponse(200, category, "Category updated successfully"));
  } catch (error) {
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A category with the ${field} '${value}' already exists.`,
        ),
      );
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

/* ================= SOFT DELETE ================= */
exports.deleteCategory = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Check if any active products are assigned to this category
    const productsCount = await Product.countDocuments({
      category: id,
      isDeleted: false, // Only consider active products
    });

    if (productsCount > 0) {
      return next(
        new ApiError(
          400,
          `Cannot delete category: it is currently assigned to ${productsCount} product(s).`,
        ),
      );
    }

    const deletedBy = req.user?._id || null;

    const category = await Category.findOneAndUpdate(
      { _id: id, isDeleted: { $ne: true } },
      {
        isDeleted: true,
        deletedAt: now(),
        deletedBy,
      },
      { new: true },
    );

    if (!category) return next(new ApiError(404, "Category not found"));

    // move to trash
    await Trash.create({
      docId: category._id,
      model: "Category",
      deletedBy,
      deletedAt: now(),
    });

    auditService.log({
      action: "DELETE",
      module: "Category",
      documentId: category._id,
      userId: deletedBy,
      description: `Deleted category "${category.name}"`,
      req,
    });

    res
      .status(200)
      .json(
        new ApiResponse(200, category, "Category moved to trash successfully"),
      );
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
