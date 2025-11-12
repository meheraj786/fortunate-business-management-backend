const DailyCash = require("../models/dailyCash.model");
const LC = require("../models/lc.model");
const Sales = require("../models/sales.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");

exports.openDailyCash = async (req, res, next) => {
  try {
    const { date } = req.body;
    const targetDate = date ? new Date(date) : new Date();
    targetDate.setHours(0, 0, 0, 0);

    const existing = await DailyCash.findOne({ date: targetDate });

    if (existing) {
      return next(
        new ApiError(
          400,
          `Cash for ${targetDate.toDateString()} is already open.`
        )
      );
    }

    const lastDay = await DailyCash.findOne({ date: { $lt: targetDate } }).sort({
      date: -1,
    });

    const openingBalance = lastDay ? lastDay.runningBalance : 0;

    const dailyCash = await DailyCash.create({
      date: targetDate,
      openingBalance: openingBalance,
      runningBalance: openingBalance,
      totalIncome: 0,
      totalExpense: 0,
      incomeList: [],
      expenseList: [],
      isClosed: false,
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

    const incomeIndex = dailyCash.incomeList.findIndex((item) => item._id.toString() === id);
    const expenseIndex = dailyCash.expenseList.findIndex((item) => item._id.toString() === id);

    if (incomeIndex === -1 && expenseIndex === -1) {
      return next(new ApiError(404, "Transaction not found"));
    }

    const originalType = incomeIndex !== -1 ? 'income' : 'expense';
    if (type && type !== originalType) {
      return next(new ApiError(400, `Cannot change transaction type. Original type was '${originalType}'.`));
    }

    if (originalType === 'income') {
      const oldAmount = dailyCash.incomeList[incomeIndex].amount;
      dailyCash.totalIncome = dailyCash.totalIncome - oldAmount + amount;
      dailyCash.runningBalance = dailyCash.runningBalance - oldAmount + amount;
      
      dailyCash.incomeList[incomeIndex] = {
        ...dailyCash.incomeList[incomeIndex]._doc,
        category: category ?? dailyCash.incomeList[incomeIndex].category,
        description: description ?? dailyCash.incomeList[incomeIndex].description,
        amount: amount ?? dailyCash.incomeList[incomeIndex].amount,
        lcId: lcId ?? dailyCash.incomeList[incomeIndex].lcId,
        time: new Date().toLocaleTimeString(),
      };
    } else { // originalType is 'expense'
      const oldAmount = dailyCash.expenseList[expenseIndex].amount;
      dailyCash.totalExpense = dailyCash.totalExpense - oldAmount + amount;
      dailyCash.runningBalance = dailyCash.runningBalance + oldAmount - amount;

      dailyCash.expenseList[expenseIndex] = {
        ...dailyCash.expenseList[expenseIndex]._doc,
        category: category ?? dailyCash.expenseList[expenseIndex].category,
        description: description ?? dailyCash.expenseList[expenseIndex].description,
        amount: amount ?? dailyCash.expenseList[expenseIndex].amount,
        lcId: lcId ?? dailyCash.expenseList[expenseIndex].lcId,
        time: new Date().toLocaleTimeString(),
      };

      if (category === "lc" && lcId) {
        const LC = require("../models/lc.model");
        await LC.findByIdAndUpdate(
          lcId,
          {
            $push: {
              expenses: {
                description: description ?? dailyCash.expenseList[expenseIndex].description,
                amount: amount ?? dailyCash.expenseList[expenseIndex].amount,
                date: new Date(),
              },
            },
          },
          { new: true }
        );
      }
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
    }).lean();

    if (!dailyCash) {
      return next(new ApiError(404, "No Daily Cash found for this date"));
    }

    const incomeTransactions = dailyCash.incomeList.map((item) => ({
      ...item,
      type: "income",
    }));
    const expenseTransactions = dailyCash.expenseList.map((item) => ({
      ...item,
      type: "expense",
    }));

    const allTransactions = [...incomeTransactions, ...expenseTransactions];

    allTransactions.sort((a, b) => b._id.getTimestamp() - a._id.getTimestamp());

    const responseData = {
      _id: dailyCash._id,
      date: dailyCash.date,
      openingBalance: dailyCash.openingBalance,
      totalIncome: dailyCash.totalIncome,
      totalExpense: dailyCash.totalExpense,
      runningBalance: dailyCash.runningBalance,
      isClosed: dailyCash.isClosed,
      transactions: allTransactions,
      createdAt: dailyCash.createdAt,
      updatedAt: dailyCash.updatedAt,
    };

    res
      .status(200)
      .json(
        new ApiResponse(200, responseData, "Daily Cash fetched successfully")
      );
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};
