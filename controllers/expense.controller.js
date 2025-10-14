const Expense = require("../models/expense.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");

async function createExpense(req, res, next) {
  try {
    const expense = await Expense.create(req.body);
    return res
      .status(201)
      .json(new ApiResponse(expense, "Expense created successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function getAllExpenses(_, res, next) {
  try {
    const expenses = await Expense.find();
    return res
      .status(200)
      .json(new ApiResponse(expenses, "Expenses fetched successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function getExpenseById(req, res, next) {
  try {
    const { id } = req.params;
    const expense = await Expense.findById(id);
    if (!expense) return next(new ApiError(404, "Expense not found"));
    return res
      .status(200)
      .json(new ApiResponse(expense, "Expense fetched successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function updateExpense(req, res, next) {
  try {
    const { id } = req.params;
    const updated = await Expense.findByIdAndUpdate(id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!updated) return next(new ApiError(404, "Expense not found"));
    return res
      .status(200)
      .json(new ApiResponse(updated, "Expense updated successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function deleteExpense(req, res, next) {
  try {
    const { id } = req.params;
    const deleted = await Expense.findByIdAndDelete(id);
    if (!deleted) return next(new ApiError(404, "Expense not found"));
    return res
      .status(200)
      .json(new ApiResponse(deleted, "Expense deleted successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

module.exports = {
  createExpense,
  getAllExpenses,
  getExpenseById,
  updateExpense,
  deleteExpense,
};
