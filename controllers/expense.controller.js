const DailyCash = require("../models/dailyCash.model");
const Expense = require("../models/expense.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");

async function createExpense(req, res, next) {
  try {
    const { date = new Date(), type, amount } = req.body;

    const expense = await Expense.create(req.body);

    const day = await DailyCash.findOne({
      date: { $eq: new Date(date).setHours(0, 0, 0, 0) },
    });

    let dailyCash;
    if (!day) {
      const lastDay = await DailyCash.findOne().sort({ date: -1 });
      const openingBalance = lastDay ? lastDay.runningBalance : 0;

      dailyCash = await DailyCash.create({
        date,
        openingBalance,
        runningBalance: openingBalance,
      });
    } else {
      dailyCash = day;
    }

    if (type === "income") {
      dailyCash.totalIncome += amount;
      dailyCash.runningBalance += amount;
    } else if (type === "expense") {
      dailyCash.totalExpense += amount;
      dailyCash.runningBalance -= amount;
    }

    dailyCash.transactions.push(expense._id);
    await dailyCash.save();

    return res
      .status(201)
      .json(
        new ApiResponse(
          { expense, dailyCash },
          "Transaction added successfully"
        )
      );
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
async function getExpenseStats(_, res, next) {
  try {
    const deleted = await Expense.findByIdAndDelete(id);
    if (!deleted) return next(new ApiError(404, "Expense not found"));
    return res
      .status(200)
      .json(new ApiResponse(deleted, "Expense deleted successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function getDailyCash(req, res, next) {
  try {
    const { date } = req.query;

    // যদি query তে date থাকে তাহলে set করো, না থাকলে আজকের তারিখ
    const inputDate = date ? new Date(date) : new Date();
    inputDate.setHours(0, 0, 0, 0);

    // date matching করার সময় নিশ্চিত হও Date comparison ঠিকভাবে হচ্ছে
    const data = await DailyCash.findOne({
      date: {
        $gte: inputDate,
        $lt: new Date(inputDate.getTime() + 24 * 60 * 60 * 1000),
      },
    }).populate("transactions");

    if (!data) return next(new ApiError(404, "No record found for this date"));

    res
      .status(200)
      .json(new ApiResponse(data, "Daily cash fetched successfully"));
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
  getExpenseStats,
  getDailyCash
};
