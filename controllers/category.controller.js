const Category = require("../models/category.model");
const Trash = require("../models/trash.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");

/* ================= CREATE ================= */
exports.createCategory = async (req, res, next) => {
  try {
    const { name, description } = req.body;

    const category = await Category.create({
      name: name.trim(),
      description,
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
          `A category with the ${field} '${value}' already exists.`
        )
      );
    }

    if (error.name === "ValidationError") {
      const firstErrorField = Object.keys(error.errors)[0];
      return next(
        new ApiError(400, `The field ${firstErrorField} is required.`)
      );
    }

    next(new ApiError(500, error.message));
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
        new ApiResponse(200, categories, "Categories fetched successfully")
      );
  } catch (error) {
    next(new ApiError(500, error.message));
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
    next(new ApiError(500, error.message));
  }
};

/* ================= UPDATE ================= */
exports.updateCategory = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, description } = req.body;

    const category = await Category.findOneAndUpdate(
      { _id: id, isDeleted: { $ne: true } },
      { name: name.trim(), description },
      { new: true, runValidators: true }
    );

    if (!category) return next(new ApiError(404, "Category not found"));

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
          `A category with the ${field} '${value}' already exists.`
        )
      );
    }

    next(new ApiError(500, error.message));
  }
};

/* ================= SOFT DELETE ================= */
exports.deleteCategory = async (req, res, next) => {
  try {
    const { id } = req.params;

    const deletedBy = req.cookies?.userId || req.user?._id || null;

    const category = await Category.findOneAndUpdate(
      { _id: id, isDeleted: { $ne: true } },
      {
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy,
      },
      { new: true }
    );

    if (!category) return next(new ApiError(404, "Category not found"));

    // move to trash
    await Trash.create({
      docId: category._id,
      model: "Category",
      deletedBy,
      deletedAt: new Date(),
    });

    res
      .status(200)
      .json(
        new ApiResponse(200, category, "Category moved to trash successfully")
      );
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};
