const DailyCash = require("../models/DailyCash");
const LC = require("../models/LC");
const Sales = require("../models/Sales");
const ApiError = require("../utils/ApiError");
const ApiResponse = require("../utils/ApiResponse");

exports.openDailyCash = async (req, res, next) => {
  try {
    const { openingBalance = 0 } = req.body;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const existing = await DailyCash.findOne({
      date: { $gte: today, $lt: new Date(today.getTime() + 24 * 60 * 60 * 1000) },
    });
    if (existing) return next(new ApiError(400, "Today's cash is already opened"));

    const lastDay = await DailyCash.findOne().sort({ date: -1 });
    const prevBalance = lastDay ? lastDay.runningBalance : 0;

    const dailyCash = await DailyCash.create({
      date: today,
      openingBalance,
      runningBalance: openingBalance + prevBalance,
    });

    res.status(201).json(new ApiResponse(dailyCash, "Daily cash opened successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

exports.addIncome = async (req, res, next) => {
  try {
    const { category, description, amount, lcId, sales } = req.body;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const dailyCash = await DailyCash.findOne({
      date: { $gte: today, $lt: new Date(today.getTime() + 24 * 60 * 60 * 1000) },
    });

    if (!dailyCash) return next(new ApiError(404, "Daily cash not opened yet"));
    if (dailyCash.isClosed) return next(new ApiError(400, "Cash is already closed for today"));

    dailyCash.totalIncome += amount;
    dailyCash.runningBalance += amount;
    dailyCash.incomeList.push({
      category,
      description,
      amount,
      time: new Date().toLocaleTimeString(),
    });

    if (lcId) {
      await LC.findByIdAndUpdate(lcId, { $push: { expenses: dailyCash._id } });
    }

    if (sales) {
      await Sales.findByIdAndUpdate(sales, { category });
    }

    await dailyCash.save();

    res.status(200).json(new ApiResponse(dailyCash, "Income added successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

exports.addExpense = async (req, res, next) => {
  try {
    const { category, description, amount, lcId, sales } = req.body;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const dailyCash = await DailyCash.findOne({
      date: { $gte: today, $lt: new Date(today.getTime() + 24 * 60 * 60 * 1000) },
    });

    if (!dailyCash) return next(new ApiError(404, "Daily cash not opened yet"));
    if (dailyCash.isClosed) return next(new ApiError(400, "Cash is already closed for today"));
    if (dailyCash.runningBalance < amount) return next(new ApiError(400, "Not enough balance"));

    dailyCash.totalExpense += amount;
    dailyCash.runningBalance -= amount;
    dailyCash.expenseList.push({
      category,
      description,
      amount,
      time: new Date().toLocaleTimeString(),
    });

    if (lcId) {
      await LC.findByIdAndUpdate(lcId, { $push: { expenses: dailyCash._id } });
    }

    if (sales) {
      await Sales.findByIdAndUpdate(sales, { category });
    }

    await dailyCash.save();

    res.status(200).json(new ApiResponse(dailyCash, "Expense added successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

exports.closeDailyCash = async (_, res, next) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const dailyCash = await DailyCash.findOne({
      date: { $gte: today, $lt: new Date(today.getTime() + 24 * 60 * 60 * 1000) },
    });

    if (!dailyCash) return next(new ApiError(404, "No cash found for today"));
    if (dailyCash.isClosed) return next(new ApiError(400, "Cash already closed"));

    dailyCash.isClosed = true;
    await dailyCash.save();

    res.status(200).json(new ApiResponse(dailyCash, "Daily cash closed successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

exports.updateTransaction = async (req, res, next) => {
  try {
    const { date } = req.params;
    const { id, type, category, description, amount } = req.body;

    const formattedDate = new Date(date).setHours(0, 0, 0, 0);
    const dailyCash = await DailyCash.findOne({ date: formattedDate });
    if (!dailyCash) return next(new ApiError(404, "No daily cash found for this date"));

    let list = type === "income" ? dailyCash.incomeList : dailyCash.expenseList;
    const index = list.findIndex((item) => item._id.toString() === id);
    if (index === -1) return next(new ApiError(404, "Transaction not found"));

    const oldAmount = list[index].amount;

    if (type === "income") {
      dailyCash.totalIncome -= oldAmount;
      dailyCash.totalIncome += amount;
      dailyCash.runningBalance += amount - oldAmount;
    } else if (type === "expense") {
      dailyCash.totalExpense -= oldAmount;
      dailyCash.totalExpense += amount;
      dailyCash.runningBalance -= amount - oldAmount;
    }

    list[index] = {
      ...list[index]._doc,
      category: category ?? list[index].category,
      description: description ?? list[index].description,
      amount: amount ?? list[index].amount,
      time: new Date().toLocaleTimeString(),
    };

    await dailyCash.save();

    res.status(200).json(new ApiResponse(dailyCash, "Transaction updated successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

exports.toggleDailyCashStatus = async (req, res, next) => {
  try {
    const { date } = req.body;
    const formattedDate = new Date(date).setHours(0, 0, 0, 0);

    const dailyCash = await DailyCash.findOne({ date: formattedDate });
    if (!dailyCash) return next(new ApiError(404, "No record found for this date"));

    dailyCash.isClosed = !dailyCash.isClosed;
    await dailyCash.save();

    res.status(200).json(
      new ApiResponse(
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

    dailyCashRecords.forEach((dc) => {
      const formattedDate = dc.date.toISOString().split("T")[0];
      if (type === "income") {
        transactions.push(
          ...dc.incomeList.map((item) => ({
            ...item._doc,
            date: formattedDate,
            type: "income",
          }))
        );
      } else if (type === "expense") {
        transactions.push(
          ...dc.expenseList.map((item) => ({
            ...item._doc,
            date: formattedDate,
            type: "expense",
          }))
        );
      } else {
        transactions.push(
          ...dc.incomeList.map((item) => ({
            ...item._doc,
            date: formattedDate,
            type: "income",
          })),
          ...dc.expenseList.map((item) => ({
            ...item._doc,
            date: formattedDate,
            type: "expense",
          }))
        );
      }
    });

    res.status(200).json(new ApiResponse(transactions, "Transactions fetched successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};
