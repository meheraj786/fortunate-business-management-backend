const Category = require("../models/category.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");

exports.createCategory = async (req, res, next) => {
  try {
    const { name, description } = req.body;
    if (!name) return next(new ApiError(400, "Category name is required"));

    const existing = await Category.findOne({ name: name.trim() });
    if (existing) return next(new ApiError(400, "Category already exists"));

    const category = await Category.create({ name: name.trim(), description });
    res
      .status(201)
      .json(new ApiResponse(category, "Category created successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

exports.getCategories = async (_, res, next) => {
  try {
    const categories = await Category.find().sort({ name: 1 });
    res
      .status(200)
      .json(new ApiResponse(categories, "Categories fetched successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

exports.getCategoryById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const category = await Category.findById(id);
    if (!category) return next(new ApiError(404, "Category not found"));

    res
      .status(200)
      .json(new ApiResponse(category, "Category fetched successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

exports.updateCategory = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, description } = req.body;

    const category = await Category.findByIdAndUpdate(
      id,
      { name: name.trim(), description },
      { new: true, runValidators: true }
    );

    if (!category) return next(new ApiError(404, "Category not found"));

    res
      .status(200)
      .json(new ApiResponse(category, "Category updated successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

exports.deleteCategory = async (req, res, next) => {
  try {
    const { id } = req.params;
    const category = await Category.findByIdAndDelete(id);
    if (!category) return next(new ApiError(404, "Category not found"));

    res
      .status(200)
      .json(new ApiResponse(category, "Category deleted successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};
