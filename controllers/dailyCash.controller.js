const DailyCash = require("../models/dailyCash.model");
const Transaction = require("../models/transaction.model");
const Account = require("../models/account.model");
const Trash = require("../models/trash.model");
const LC = require("../models/lc.model");
const Sale = require("../models/sales.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const mongoose = require("mongoose");
const logger = require("../utils/logger");

async function openCash(req, res, next) {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const requestedDate = req.body.date ? new Date(req.body.date) : today;
    requestedDate.setHours(0, 0, 0, 0);

    if (requestedDate.getTime() !== today.getTime()) {
      return next(new ApiError(400, "Cash can only be opened for the current day."));
    }

    const openSession = await DailyCash.findOne({ date: today, status: "Open" });
    if (openSession) {
      return next(new ApiError(400, `Daily cash for ${today.toDateString()} is already open.`));
    }

    let openingBalance;
    const lastSessionToday = await DailyCash.findOne({ date: today }).sort({ createdAt: -1 });

    if (lastSessionToday) {
      openingBalance = lastSessionToday.closingBalance;
    } else {
      const previousDay = new Date(today);
      previousDay.setDate(today.getDate() - 1);
      previousDay.setHours(0, 0, 0, 0);

      const lastSessionYesterday = await DailyCash.findOne({ date: previousDay }).sort({ createdAt: -1 });

      if (lastSessionYesterday) {
        if (lastSessionYesterday.status === 'Open') {
          const prevDayMetrics = await _calculateDailyCashMetrics(previousDay.toISOString());
          openingBalance = prevDayMetrics.runningBalance;

          lastSessionYesterday.status = "Closed";
          const endOfPreviousDay = new Date(previousDay);
          endOfPreviousDay.setHours(23, 59, 59, 999);
          lastSessionYesterday.closedAt = endOfPreviousDay;
          lastSessionYesterday.closingBalance = openingBalance;
          await lastSessionYesterday.save();
        } else {
          openingBalance = lastSessionYesterday.closingBalance;
        }
      } else {
        const firstEverEntry = await DailyCash.findOne().sort({ createdAt: 'asc' });
        if (!firstEverEntry) {
          const totalAccountBalance = await Account.aggregate([
            { $match: { isDeleted: { $ne: true } } },
            { $group: { _id: null, totalBalance: { $sum: "$balance" } } },
          ]);
          openingBalance = totalAccountBalance.length > 0 ? totalAccountBalance[0].totalBalance : 0;
        } else {
          openingBalance = 0;
        }
      }
    }

    const newDailyCashSession = await DailyCash.create({
      date: today,
      status: "Open",
      openingBalance: openingBalance,
      openedAt: new Date(),
    });

    return res.status(201).json(new ApiResponse(201, newDailyCashSession, "Daily cash opened."));
  } catch (error) {
    next(error);
  }
}

async function closeCash(req, res, next) {
  try {
    const { date } = req.body;
    if (!date) return next(new ApiError(400, "Date is required."));

    const targetDate = new Date(date);
    targetDate.setHours(0, 0, 0, 0);

    const openSession = await DailyCash.findOne({ date: targetDate, status: "Open" });
    if (!openSession) return next(new ApiError(404, "No open session found."));

    const metrics = await _calculateDailyCashMetrics(targetDate.toISOString());
    openSession.status = "Closed";
    openSession.closedAt = new Date();
    openSession.closingBalance = metrics.runningBalance;
    await openSession.save();

    return res.status(200).json(new ApiResponse(200, openSession, "Daily cash closed."));
  } catch (error) {
    next(error);
  }
}

async function _calculateDailyCashMetrics(dateString) {
  const targetDate = new Date(dateString);
  targetDate.setHours(0, 0, 0, 0);
  const nextDay = new Date(targetDate);
  nextDay.setDate(targetDate.getDate() + 1);

  const sessions = await DailyCash.find({ date: targetDate }).sort({ createdAt: 'asc' });
  let openingBalance = sessions.length > 0 ? sessions[0].openingBalance : 0;
  
  if (sessions.length === 0) {
    const previousDay = new Date(targetDate);
    previousDay.setDate(targetDate.getDate() - 1);
    const prevSession = await DailyCash.findOne({ date: previousDay }).sort({ createdAt: -1 });
    openingBalance = prevSession ? prevSession.closingBalance : 0;
  }

  const transactionResults = await Transaction.aggregate([
    {
      $match: {
        date: { $gte: targetDate, $lt: nextDay },
        isDeleted: { $ne: true }
      }
    },
    {
      $lookup: {
        from: "accounts",
        localField: "accountId",
        foreignField: "_id",
        as: "account"
      }
    },
    { $unwind: "$account" },
    {
      $group: {
        _id: null,
        totalIncome: { $sum: { $cond: [{ $eq: ["$transactionType", "Income"] }, "$amount", 0] } },
        totalExpenses: { $sum: { $cond: [{ $eq: ["$transactionType", "Expense"] }, "$amount", 0] } },
        transactions: { $push: "$$ROOT" }
      }
    }
  ]);

  const totalIncome = transactionResults[0]?.totalIncome || 0;
  const totalExpenses = transactionResults[0]?.totalExpenses || 0;
  const runningBalance = openingBalance + totalIncome - totalExpenses;

  return {
    date: targetDate,
    status: sessions[sessions.length - 1]?.status || "Closed",
    openingBalance,
    totalIncome,
    totalExpenses,
    runningBalance,
    transactions: transactionResults[0]?.transactions || [],
    dailyCashSessions: sessions
  };
}

async function getDailyCashSummary(req, res, next) {
  try {
    const { date } = req.query;
    const metrics = await _calculateDailyCashMetrics(date);
    res.status(200).json(new ApiResponse(200, metrics, "Summary fetched."));
  } catch (error) {
    next(error);
  }
}

async function addIncome(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { amount, category, name, paymentMethod, accountId, description, lcId, salesId } = req.body;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const openSession = await DailyCash.findOne({ date: today, status: "Open" });
    if (!openSession) throw new ApiError(400, "Daily cash is closed.");

    const account = await Account.findOne({ _id: accountId, isDeleted: { $ne: true } }).session(session);
    if (!account) throw new ApiError(404, "Account not found.");

    let reference = null, referenceModel = null, miscReference = {};
    if (category === "LC") {
      const lc = await LC.findById(lcId);
      reference = lcId; referenceModel = "LC"; miscReference = { lcNumber: lc?.basicInfo?.lcNumber };
    } else if (category === "Sales") {
      const sale = await Sale.findById(salesId);
      reference = salesId; referenceModel = "Sale"; miscReference = { saleId: sale?.saleId };
    }

    account.balance += amount;
    await account.save({ session });

    const transaction = await Transaction.create([{
      accountId, amount, name, category, paymentMethod, description, reference, referenceModel, miscReference,
      transactionType: "Income", date: new Date(), source: "Manual", isDeleted: false
    }], { session });

    await session.commitTransaction();
    res.status(201).json(new ApiResponse(201, transaction[0], "Income added."));
  } catch (error) {
    await session.abortTransaction();
    next(error);
  } finally {
    session.endSession();
  }
}

async function addExpense(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { amount, category, name, paymentMethod, accountId, description, lcId, salesId, lcCostCategory } = req.body;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const openSession = await DailyCash.findOne({ date: today, status: "Open" });
    if (!openSession) throw new ApiError(400, "Daily cash is closed.");

    const account = await Account.findOne({ _id: accountId, isDeleted: { $ne: true } }).session(session);
    if (!account || account.balance < amount) throw new ApiError(400, "Invalid account or insufficient balance.");

    let reference = null, referenceModel = null, miscReference = {};
    if (category === "LC") {
      const lc = await LC.findById(lcId).session(session);
      const target = lcCostCategory || "otherExpenses";
      lc[target].costs.push({ name, amount, date: new Date(), paymentMethod, accountId });
      await lc.save({ session });
      reference = lcId; referenceModel = "LC"; miscReference = { lcNumber: lc.basicInfo.lcNumber };
    } else if (category === "Sales") {
      const sale = await Sale.findById(salesId).session(session);
      sale.otherCharges.push({ name, amount });
      await sale.save({ session });
      reference = salesId; referenceModel = "Sale"; miscReference = { saleId: sale.saleId };
    }

    account.balance -= amount;
    await account.save({ session });

    const transaction = await Transaction.create([{
      accountId, amount, name, category, paymentMethod, description, reference, referenceModel, miscReference,
      transactionType: "Expense", date: new Date(), source: "Manual", isDeleted: false
    }], { session });

    await session.commitTransaction();
    res.status(201).json(new ApiResponse(201, transaction[0], "Expense added."));
  } catch (error) {
    await session.abortTransaction();
    next(error);
  } finally {
    session.endSession();
  }
}

async function deleteIncomeOrExpense(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const deletedBy = req.user?._id || req.cookies?.userId || null;

    const transaction = await Transaction.findOne({ _id: id, isDeleted: { $ne: true } }).session(session);
    if (!transaction) throw new ApiError(404, "Transaction not found.");

    const transDate = new Date(transaction.date);
    transDate.setHours(0, 0, 0, 0);
    const openSession = await DailyCash.findOne({ date: transDate, status: "Open" }).session(session);
    if (!openSession) throw new ApiError(400, "Daily cash session is closed for this date.");

    const account = await Account.findById(transaction.accountId).session(session);
    if (account) {
      if (transaction.transactionType === "Income") account.balance -= transaction.amount;
      else account.balance += transaction.amount;
      await account.save({ session });
    }

    transaction.isDeleted = true;
    await transaction.save({ session });

    await Trash.create([{ docId: transaction._id, model: "Transaction", deletedBy }], { session });

    await session.commitTransaction();
    res.status(200).json(new ApiResponse(200, null, "Transaction deleted."));
  } catch (error) {
    await session.abortTransaction();
    next(error);
  } finally {
    session.endSession();
  }
}

async function getDailyCashStatus(req, res, next) {
  try {
    const { date } = req.query;
    const targetDate = new Date(date);
    targetDate.setHours(0, 0, 0, 0);
    const lastSession = await DailyCash.findOne({ date: targetDate }).sort({ createdAt: -1 });
    res.status(200).json(new ApiResponse(200, { status: lastSession?.status || "Not Opened Yet", date: targetDate }));
  } catch (error) {
    next(error);
  }
}

async function autoCloseDailyCashForCron() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const openSession = await DailyCash.findOne({ date: today, status: "Open" });
  if (openSession) {
    const metrics = await _calculateDailyCashMetrics(today.toISOString());
    openSession.status = "Closed";
    openSession.closedAt = new Date();
    openSession.closingBalance = metrics.runningBalance;
    await openSession.save();
  }
}

async function closeMissedDailyCashEntries() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const missed = await DailyCash.find({ date: { $lt: today }, status: "Open" });
  for (const entry of missed) {
    const metrics = await _calculateDailyCashMetrics(entry.date.toISOString());
    entry.status = "Closed";
    entry.closedAt = new Date();
    entry.closingBalance = metrics.runningBalance;
    await entry.save();
  }
}

module.exports = {
  openCash,
  closeCash,
  getDailyCashStatus,
  getDailyCashSummary,
  addIncome,
  addExpense,
  autoCloseDailyCashForCron,
  closeMissedDailyCashEntries,
  deleteIncomeOrExpense
};