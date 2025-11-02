const LC = require("../models/lc.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");

async function createLC(req, res, next) {
  try {
    const lc = await LC.create(req.body);
    return res.status(201).json(new ApiResponse(lc, "LC created successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function getAllLCs(_, res, next) {
  try {
    const lcs = await LC.find();
    return res
      .status(200)
      .json(new ApiResponse(lcs, "All LCs fetched successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function getLCById(req, res, next) {
  try {
    const { id } = req.params;
    const lc = await LC.findById(id);
    if (!lc) return next(new ApiError(404, "LC not found"));
    return res.status(200).json(new ApiResponse(lc, "LC fetched successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function updateLC(req, res, next) {
  try {
    const { id } = req.params;
    const updated = await LC.findByIdAndUpdate(id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!updated) return next(new ApiError(404, "LC not found"));
    return res
      .status(200)
      .json(new ApiResponse(updated, "LC updated successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function deleteLC(req, res, next) {
  try {
    const { id } = req.params;
    const deleted = await LC.findByIdAndDelete(id);
    if (!deleted) return next(new ApiError(404, "LC not found"));
    return res
      .status(200)
      .json(new ApiResponse(deleted, "LC deleted successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function addExpenseToLC(req, res, next) {
  try {
    const { lcId } = req.params;
    const { description, amount, date } = req.body;

    if (!description || !amount) {
      throw new ApiError(400, "Description and amount are required");
    }

    const lc = await LC.findById(lcId);
    if (!lc) {
      throw new ApiError(404, "LC not found");
    }

    const newExpense = {
      description,
      amount,
      date: date || new Date(),
    };

    lc.expenses.push(newExpense);

    lc.totalExpense = (lc.totalExpense || 0) + amount;

    await lc.save();

    return res
      .status(200)
      .json(new ApiResponse(200, lc, "Expense added successfully"));
  } catch (error) {
    next(error);
  }
}

module.exports = {
  createLC,
  getAllLCs,
  getLCById,
  updateLC,
  deleteLC,
  addExpenseToLC,
};
