const DailyCash = require("../models/dailyCash.model");
const LC = require("../models/lc.model");
const Sales = require("../models/sales.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");

exports.openDailyCash = async (req, res, next) => {
  try {
    const { openingBalance = 0 } = req.body;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const existing = await DailyCash.findOne({
      date: {
        $gte: today,
        $lt: new Date(today.getTime() + 24 * 60 * 60 * 1000),
      },
    });

    if (existing)
      return next(new ApiError(400, "Today's cash is already opened"));

    const lastDay = await DailyCash.findOne().sort({ date: -1 });
    const prevBalance = lastDay ? lastDay.runningBalance : 0;

    const dailyCash = await DailyCash.create({
      date: today,
      openingBalance,
      runningBalance: prevBalance || openingBalance,
    });

    res
      .status(201)
      .json(
        new ApiResponse(201, dailyCash, "Daily cash opened successfully")
      );
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

exports.addIncome = async (req, res, next) => {
  try {
    const {
      category,
      description,
      amount,
      paymentMethod,
      bankNumber,
      mobileBank,
      lcId,
      sales,
      date,
    } = req.body;

    const selectedDate = new Date(date || new Date());
    selectedDate.setHours(0, 0, 0, 0);

    const dailyCash = await DailyCash.findOne({
      date: {
        $gte: selectedDate,
        $lt: new Date(selectedDate.getTime() + 24 * 60 * 60 * 1000),
      },
    });

    if (!dailyCash)
      return next(new ApiError(404, "No daily cash found for this date"));
    if (dailyCash.isClosed)
      return next(new ApiError(400, "Cash already closed for this day"));

    dailyCash.totalIncome += amount;
    dailyCash.runningBalance += amount;

    dailyCash.incomeList.push({
      category,
      description,
      amount,
      paymentMethod,
      bankNumber,
      mobileBank,
      lcId,
      sales,
      time: new Date().toLocaleTimeString(),
    });

    await dailyCash.save();

    res
      .status(200)
      .json(new ApiResponse(200, dailyCash, "Income added successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

exports.addExpense = async (req, res, next) => {
  try {
    const {
      category,
      description,
      amount,
      paymentMethod,
      bankNumber,
      mobileBank,
      lcId,
      sales,
      date,
    } = req.body;

    const selectedDate = new Date(date || new Date());
    selectedDate.setHours(0, 0, 0, 0);

    const dailyCash = await DailyCash.findOne({
      date: {
        $gte: selectedDate,
        $lt: new Date(selectedDate.getTime() + 24 * 60 * 60 * 1000),
      },
    });

    if (!dailyCash)
      return next(new ApiError(404, "No daily cash found for this date"));
    if (dailyCash.isClosed)
      return next(new ApiError(400, "Cash already closed for this day"));
    if (dailyCash.runningBalance < amount)
      return next(new ApiError(400, "Insufficient balance"));

    dailyCash.totalExpense += amount;
    dailyCash.runningBalance -= amount;

    const expense = {
      category,
      description,
      amount,
      paymentMethod,
      bankNumber,
      mobileBank,
      lcId,
      sales,
      time: new Date().toLocaleTimeString(),
    };

    dailyCash.expenseList.push(expense);

    if (category === "lc" && lcId) {
      const lc = await LC.findById(lcId);
      if (!lc) return next(new ApiError(404, "LC not found"));

      lc.expenses.push({
        description: description || "LC related expense",
        amount,
        date: new Date(),
        paymentMethod,
      });

      await lc.save();
    }

    await dailyCash.save();

    res
      .status(200)
      .json(new ApiResponse(200, dailyCash, "Expense added successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

exports.closeDailyCash = async (req, res, next) => {
  try {
    const { date } = req.body;
    const selectedDate = new Date(date || new Date());
    selectedDate.setHours(0, 0, 0, 0);

    const dailyCash = await DailyCash.findOne({
      date: {
        $gte: selectedDate,
        $lt: new Date(selectedDate.getTime() + 24 * 60 * 60 * 1000),
      },
    });

    if (!dailyCash)
      return next(new ApiError(404, "No cash found for this date"));
    if (dailyCash.isClosed)
      return next(new ApiError(400, "Cash already closed"));

    dailyCash.isClosed = true;
    await dailyCash.save();

    res
      .status(200)
      .json(
        new ApiResponse(200, dailyCash, "Daily cash closed successfully")
      );
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

exports.updateTransaction = async (req, res, next) => {
  try {
    const { date } = req.params;
    const { id, type, category, description, amount, lcId } = req.body;

    const formattedDate = new Date(date).setHours(0, 0, 0, 0);
    const dailyCash = await DailyCash.findOne({ date: formattedDate });

    if (!dailyCash)
      return next(new ApiError(404, "No daily cash found for this date"));
    if (dailyCash.isClosed)
      return next(new ApiError(400, "Daily cash is closed for this date"));

    let list = type === "income" ? dailyCash.incomeList : dailyCash.expenseList;
    const index = list.findIndex((item) => item._id.toString() === id);
    if (index === -1) return next(new ApiError(404, "Transaction not found"));

    const oldAmount = list[index].amount;

    if (type === "income") {
      dailyCash.totalIncome -= oldAmount;
      dailyCash.totalIncome += amount;
      dailyCash.runningBalance += amount - oldAmount;
    } else {
      dailyCash.totalExpense -= oldAmount;
      dailyCash.totalExpense += amount;
      dailyCash.runningBalance -= amount - oldAmount;
    }

    list[index] = {
      ...list[index]._doc,
      category: category ?? list[index].category,
      description: description ?? list[index].description,
      amount: amount ?? list[index].amount,
      lcId: lcId ?? list[index].lcId,
      time: new Date().toLocaleTimeString(),
    };

    if (type === "expense" && category === "lc" && lcId) {
      const LC = require("../models/lc.model");
      await LC.findByIdAndUpdate(
        lcId,
        {
          $push: {
            expenses: {
              description: description ?? list[index].description,
              amount: amount ?? list[index].amount,
              date: new Date(),
            },
          },
        },
        { new: true }
      );
    }

    await dailyCash.save();

    res
      .status(200)
      .json(
        new ApiResponse(200, dailyCash, "Transaction updated successfully")
      );
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

exports.toggleDailyCashStatus = async (req, res, next) => {
  try {
    const { date } = req.body;
    const formattedDate = new Date(date).setHours(0, 0, 0, 0);

    const dailyCash = await DailyCash.findOne({ date: formattedDate });
    if (!dailyCash)
      return next(new ApiError(404, "No record found for this date"));

    dailyCash.isClosed = !dailyCash.isClosed;
    await dailyCash.save();

    res
      .status(200)
      .json(
        new ApiResponse(
          200,
          dailyCash,
          dailyCash.isClosed
            ? "Daily cash closed successfully"
            : "Daily cash reopened successfully"
        )
      );
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

exports.getTransactionsByDateRange = async (req, res, next) => {
  try {
    const { from, to, type } = req.query;
    const start = new Date(from).setHours(0, 0, 0, 0);
    const end = new Date(to).setHours(23, 59, 59, 999);

    const dailyCashRecords = await DailyCash.find({
      date: { $gte: start, $lte: end },
    }).sort({ date: 1 });

    if (!dailyCashRecords.length)
      return next(new ApiError(404, "No records found for this date range"));

    let transactions = [];

    for (const dc of dailyCashRecords) {
      const formattedDate = dc.date.toISOString().split("T")[0];
      const addTransactions = (list, type) =>
        list.map((item) => ({
          ...item._doc,
          date: formattedDate,
          type,
          dailyCashId: dc._id,
        }));

      if (type === "income")
        transactions.push(...addTransactions(dc.incomeList, "income"));
      else if (type === "expense")
        transactions.push(...addTransactions(dc.expenseList, "expense"));
      else
        transactions.push(
          ...addTransactions(dc.incomeList, "income"),
          ...addTransactions(dc.expenseList, "expense")
        );
    }

    res
      .status(200)
      .json(
        new ApiResponse(200, transactions, "Transactions fetched successfully")
      );
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};
exports.getDailyCash = async (req, res, next) => {
  try {
    let { date } = req.query;

    let targetDate;
    if (date) {
      targetDate = new Date(date);
    } else {
      targetDate = new Date();
    }
    targetDate.setHours(0, 0, 0, 0);

    const dailyCash = await DailyCash.findOne({
      date: targetDate,
    });

    if (!dailyCash) {
      return next(new ApiError(404, "No Daily Cash found for this date"));
    }

    res
      .status(200)
      .json(new ApiResponse(200, dailyCash, "Daily Cash fetched successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};
