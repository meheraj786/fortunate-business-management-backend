const DailyCash = require("../models/dailyCash.model");
const Transaction = require("../models/transaction.model");
const Account = require("../models/account.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const mongoose = require("mongoose");

// @desc    Open a new cash session for the current day
// @route   POST /api/cash/open
// @access  Private (Admin)
async function openCash(req, res, next) {
  try {
    // 1. Validate date: Only allow opening for the current day
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const requestedDate = req.body.date ? new Date(req.body.date) : today;
    requestedDate.setHours(0, 0, 0, 0);

    if (requestedDate.getTime() !== today.getTime()) {
      return next(new ApiError(400, "Cash can only be opened for the current day."));
    }

    // 2. Check if cash for today is already open
    const openSession = await DailyCash.findOne({ date: today, status: "Open" });
    if (openSession) {
      return next(new ApiError(400, `Daily cash for ${today.toDateString()} is already open.`));
    }

    // 3. Calculate opening balance
    let openingBalance;
    const lastSessionToday = await DailyCash.findOne({ date: today }).sort({ createdAt: -1 });

    if (lastSessionToday) {
      // This is a reopening on the same day. Opening balance is the last closing balance.
      openingBalance = lastSessionToday.closingBalance;
    } else {
      // This is the first opening of the day. Auto-close previous day if forgotten.
      const previousDay = new Date(today);
      previousDay.setDate(today.getDate() - 1);
      previousDay.setHours(0, 0, 0, 0);

      const lastSessionYesterday = await DailyCash.findOne({ date: previousDay }).sort({ createdAt: -1 });

      if (lastSessionYesterday) {
        if (lastSessionYesterday.status === 'Open') {
          // If yesterday was left open, we need to calculate its running balance and close it.
          const prevDayMetrics = await _calculateDailyCashMetrics(previousDay.toISOString());
          openingBalance = prevDayMetrics.runningBalance; // Today's opening is yesterday's running balance

          // Auto-close yesterday's session
          lastSessionYesterday.status = "Closed";
          const endOfPreviousDay = new Date(previousDay);
          endOfPreviousDay.setHours(23, 59, 59, 999);
          lastSessionYesterday.closedAt = endOfPreviousDay;
          lastSessionYesterday.closingBalance = openingBalance;
          await lastSessionYesterday.save();
          console.log(`Auto-closed daily cash for ${previousDay.toDateString()}.`);
        } else { // Yesterday's last session was closed
          openingBalance = lastSessionYesterday.closingBalance;
        }
      } else {
        // No session yesterday, could be the first ever opening in the system.
        const firstEverEntry = await DailyCash.findOne().sort({ createdAt: 'asc' });
        if (!firstEverEntry) {
            // Sum all account balances as the very first opening balance
            const totalAccountBalance = await Account.aggregate([
                { $group: { _id: null, totalBalance: { $sum: "$balance" } } },
            ]);
            openingBalance = totalAccountBalance.length > 0 ? totalAccountBalance[0].totalBalance : 0;
        } else {
            openingBalance = 0; // Default if no history and not the first ever
        }
      }
    }
    
    if (typeof openingBalance === 'undefined') {
        return next(new ApiError(500, "Could not determine opening balance."));
    }

    // 4. Create new DailyCash session for today
    const newDailyCashSession = await DailyCash.create({
      date: today,
      status: "Open",
      openingBalance: openingBalance,
      openedAt: new Date(),
    });

    return res
      .status(201)
      .json(new ApiResponse(201, newDailyCashSession, `Daily cash for ${today.toDateString()} opened successfully with an opening balance of ${openingBalance}.`));
  } catch (error) {
    next(new ApiError(500, error.message || "Error opening daily cash."));
  }
}

// @desc    Close the currently open cash session for a specific day
// @route   POST /api/cash/close
// @access  Private (Admin)
async function closeCash(req, res, next) {
  try {
    const { date } = req.body;
    if (!date) {
      return next(new ApiError(400, "Date is required to close daily cash."));
    }

    const targetDate = new Date(date);
    targetDate.setHours(0, 0, 0, 0);

    // 1. Find the currently open session for the target date
    const openSession = await DailyCash.findOne({ date: targetDate, status: "Open" });

    if (!openSession) {
      return next(new ApiError(404, `No open daily cash session found for ${targetDate.toDateString()} to close.`));
    }

    // 2. Calculate final running balance for the WHOLE day
    const metrics = await _calculateDailyCashMetrics(targetDate.toISOString());
    const finalRunningBalance = metrics.runningBalance;

    // 3. Update the open session document
    openSession.status = "Closed";
    openSession.closedAt = new Date();
    openSession.closingBalance = finalRunningBalance;
    await openSession.save();

    // 4. Recalculate metrics to get the final state with the closed session
    const finalMetrics = await _calculateDailyCashMetrics(targetDate.toISOString());

    return res
      .status(200)
      .json(new ApiResponse(200, finalMetrics, `Daily cash for ${targetDate.toDateString()} closed successfully with a closing balance of ${finalRunningBalance}.`));
  } catch (error) {
    next(new ApiError(500, error.message || "Error closing daily cash."));
  }
}

// @desc    Get the status of the last cash session for a specific date
// @route   GET /api/cash/status/:date
// @access  Private
async function getDailyCashStatus(req, res, next) {
  try {
    const { date } = req.query;
    if (!date) {
      return next(new ApiError(400, "Date is required to get daily cash status."));
    }

    const targetDate = new Date(date);
    targetDate.setHours(0, 0, 0, 0);

    // Find the last session for the date to determine the current status
    const lastSession = await DailyCash.findOne({ date: targetDate }).sort({ createdAt: -1 });

    if (lastSession) {
      return res
        .status(200)
        .json(
          new ApiResponse(
            200,
            { status: lastSession.status, date: lastSession.date },
            `Daily cash status for ${targetDate.toDateString()} fetched successfully.`
          )
        );
    } else {
      return res
        .status(200)
        .json(
          new ApiResponse(
            200,
            { status: "Not Opened Yet", date: targetDate },
            `Daily cash for ${targetDate.toDateString()} has not been opened yet.`
          )
        );
    }
  } catch (error) {
    next(new ApiError(500, error.message || "Error fetching daily cash status."));
  }
}

// Helper function to calculate daily cash metrics for a whole day
async function _calculateDailyCashMetrics(dateString) {
  const targetDate = new Date(dateString);
  targetDate.setHours(0, 0, 0, 0);
  const nextDay = new Date(targetDate);
  nextDay.setDate(targetDate.getDate() + 1);

  // Get all sessions for the target date, sorted by creation time
  const sessions = await DailyCash.find({ date: targetDate }).sort({ createdAt: 'asc' });

  let openingBalance = 0;
  let status = "Not Opened Yet";

  if (sessions.length > 0) {
    // The day's opening balance is the opening balance of the very first session
    openingBalance = sessions[0].openingBalance;
    // The day's overall status is the status of the very last session
    status = sessions[sessions.length - 1].status;
  } else {
    // If no sessions for today, calculate opening balance from previous day's last session
    const previousDay = new Date(targetDate);
    previousDay.setDate(targetDate.getDate() - 1);
    previousDay.setHours(0, 0, 0, 0);

    const prevDayLastSession = await DailyCash.findOne({ date: previousDay }).sort({ createdAt: -1 });

    if (prevDayLastSession) {
        if (prevDayLastSession.status === "Closed") {
            openingBalance = prevDayLastSession.closingBalance || 0;
        } else if (prevDayLastSession.status === "Open") {
            // This case should ideally be handled by the startup/cron jobs, but as a fallback:
            const prevDayMetrics = await _calculateDailyCashMetrics(previousDay.toISOString());
            openingBalance = prevDayMetrics.runningBalance;
        }
    } else {
        // Very first entry in the system logic
        const firstEverEntry = await DailyCash.findOne().sort({ createdAt: 'asc' });
        if (!firstEverEntry) {
            const totalAccountBalance = await Account.aggregate([
                { $group: { _id: null, totalBalance: { $sum: "$balance" } } },
            ]);
            openingBalance = totalAccountBalance.length > 0 ? totalAccountBalance[0].totalBalance : 0;
        }
    }
  }

  // Transactions are for the whole day, regardless of sessions
  const transactions = await Transaction.find({
    date: { $gte: targetDate, $lt: nextDay },
  }).populate("accountId", "accountName accountType");

  const totalIncome = transactions
    .filter((t) => t.transactionType === "Income")
    .reduce((sum, t) => sum + t.amount, 0);
  const totalExpenses = transactions
    .filter((t) => t.transactionType === "Expense")
    .reduce((sum, t) => sum + t.amount, 0);

  // Running balance is based on the day's starting opening balance
  const runningBalance = openingBalance + totalIncome - totalExpenses;

  return {
    date: targetDate,
    status, // Status of the last session
    openingBalance, // Opening balance of the first session
    totalIncome,
    totalExpenses,
    runningBalance,
    transactions,
    dailyCashSessions: sessions, // Return all session documents for the day
  };
}


// @desc    Get a summary of daily cash for a specific date
// @route   GET /api/cash/summary/:date
// @access  Private
async function getDailyCashSummary(req, res, next) {
  try {
    const { date } = req.query;
    if (!date) {
      return next(new ApiError(400, "Date is required to get daily cash summary."));
    }
    const metrics = await _calculateDailyCashMetrics(date);
    return res.status(200).json(new ApiResponse(200, metrics, `Daily cash summary for ${new Date(date).toDateString()} fetched successfully.`));
  } catch (error) {
    next(new ApiError(500, error.message || "Error fetching daily cash summary."));
  }
}

// @desc    Add a manual income transaction
// @route   POST /api/cash/income
// @access  Private
const LC = require("../models/lc.model");
const Sale = require("../models/sales.model");

async function addIncome(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const {
      amount,
      category,
      name, // income name
      paymentMethod,
      accountId,
      description, // user provided description
      lcId, // optional for LC category
      salesId, // optional for Sales category
    } = req.body;

    // 1. Gatekeeper: Check if Daily Cash for today is Open
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const openSession = await DailyCash.findOne({ date: today, status: "Open" });

    if (!openSession) {
      throw new ApiError(400, "Daily cash is closed. Cannot add income.");
    }

    // 2. Validate input
    if (!amount || amount <= 0) throw new ApiError(400, "Amount is required and must be positive.");
    if (!category) throw new ApiError(400, "Category is required.");
    if (!name) throw new ApiError(400, "Income name is required.");
    if (!paymentMethod) throw new ApiError(400, "Payment method is required.");
    if (!accountId) throw new ApiError(400, "Account ID is required for payment.");

    const account = await Account.findById(accountId).session(session);
    if (!account) throw new ApiError(404, "Account not found.");
    if (account.accountType !== paymentMethod) {
      throw new ApiError(400, `Payment method '${paymentMethod}' requires a matching account type.`);
    }

    let finalDescription = description;
    let reference = null;
    let referenceModel = null;
    let miscReference = {};
    const incomeCategories = ["LC", "Sales", "Donation", "Commission", "Interest", "Service Charge", "Others"];
    if (!incomeCategories.includes(category)) throw new ApiError(400, "Invalid income category.");

    if (category === "LC") {
      if (!lcId) {
        throw new ApiError(400, "LC ID is mandatory for LC income category.");
      }
      const lc = await LC.findById(lcId);
      if (!lc) {
        throw new ApiError(404, "LC not found.");
      }
      // Updated description format for LC income
      finalDescription = `${name} Income from LC Number: ${lc.basicInfo.lcNumber} via ${paymentMethod} Account: ${account.accountName} - holder name:${account.accountName}.`;
      reference = lcId;
      referenceModel = "LC";
      miscReference = { lcNumber: lc.basicInfo.lcNumber };
    } else if (category === "Sales") {
      if (!salesId) {
        throw new ApiError(400, "Sales ID is mandatory for Sales income category.");
      }
      const sale = await Sale.findById(salesId);
      if (!sale) {
        throw new ApiError(404, "Sale not found.");
      }
      // Updated description format for Sales income
      finalDescription = `${name} Income from Sale ID: ${sale.saleId} (Customer: ${sale.customer.name}) via ${paymentMethod} Account: ${account.accountName} - holder name:${account.accountName}.`;
      reference = salesId;
      referenceModel = "Sale";
      miscReference = { saleId: sale.saleId, customerName: sale.customer.name };
    }

    // 3. Update Account Balance
    account.balance += amount;
    await account.save({ session });

    const newTransaction = new Transaction({ accountId, date: new Date(), transactionType: "Income", amount, name, source: "Manual", paymentMethod, description: finalDescription, category, reference, referenceModel, miscReference });
    await newTransaction.save({ session });

    await session.commitTransaction();
    session.endSession();

    return res.status(201).json(new ApiResponse(201, newTransaction, "Income added successfully."));
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    next(error instanceof ApiError ? error : new ApiError(500, error.message || "An internal server error occurred."));
  }
}

// @desc    Add a manual expense transaction
// @route   POST /api/cash/expense
// @access  Private
async function addExpense(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { amount, category, name, paymentMethod, accountId, description, lcId, salesId, lcCostCategory } = req.body;

    // 1. Gatekeeper: Check if Daily Cash for today is Open
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const openSession = await DailyCash.findOne({ date: today, status: "Open" });
    if (!openSession) throw new ApiError(400, "Daily cash is closed. Cannot add expense.");

    // 2. Universal Validation
    if (!amount || amount <= 0) throw new ApiError(400, "Amount is required and must be positive.");
    if (!category) throw new ApiError(400, "Category is required.");
    if (!paymentMethod) throw new ApiError(400, "Payment method is required.");
    if (!accountId) throw new ApiError(400, "Account ID is required for payment.");

    const account = await Account.findById(accountId).session(session);
    if (!account) throw new ApiError(404, "Account not found.");
    if (account.accountType !== paymentMethod) throw new ApiError(400, "Payment method requires a matching account type.");
    if (account.balance < amount) throw new ApiError(400, `Insufficient balance in ${account.accountName}.`);

    let finalDescription = description;
    let transactionName = name; // Default to user-provided name
    let reference = null;
    let referenceModel = null;
    let miscReference = {};
    const expenseCategories = ["LC", "Sales", "Rent", "Salary", "Office Expense", "Transport", "Utility", "Others"];
    if (!expenseCategories.includes(category)) throw new ApiError(400, "Invalid expense category.");

    // 3. Category-Specific Logic
    if (category === "LC") {
      if (!name) throw new ApiError(400, "An expense name is required for LC expenses.");
      if (!lcId) throw new ApiError(400, "LC ID is mandatory for an LC expense.");
      const lc = await LC.findById(lcId).session(session);
      if (!lc) throw new ApiError(404, "LC not found.");

      const validLCCategories = ["financialInfo", "shippingCustomsInfo", "agentTransportInfo", "otherExpenses"];
      const targetLCCostCategory = lcCostCategory && validLCCategories.includes(lcCostCategory) ? lcCostCategory : "otherExpenses";

      if (!lc[targetLCCostCategory]) lc[targetLCCostCategory] = { costs: [] };
      else if (!lc[targetLCCostCategory].costs) lc[targetLCCostCategory].costs = [];
      
      lc[targetLCCostCategory].costs.push({ name: name, amount, date: new Date(), paymentMethod, accountId });
      await lc.save({ session });

      finalDescription = `Expense for LC: ${lc.basicInfo.lcNumber}, Cost: ${name}.`;
      reference = lcId;
      referenceModel = "LC";
      miscReference = { costName: name, lcNumber: lc.basicInfo.lcNumber, lcCostCategory: targetLCCostCategory };
    
    } else if (category === "Sales") {
      if (!name) throw new ApiError(400, "An expense name is required for Sales expenses.");
      if (!salesId) throw new ApiError(400, "Sales ID is mandatory for a Sales expense.");
      const sale = await Sale.findById(salesId).session(session);
      if (!sale) throw new ApiError(404, "Sale not found.");

      sale.otherCharges.push({ name: name, amount });
      await sale.save({ session }); // Let pre-save hook handle paymentStatus

      finalDescription = `Expense for Sale: ${sale.saleId}, Cost: ${name}.`;
      reference = salesId;
      referenceModel = "Sale";
      miscReference = { costName: name, saleId: sale.saleId, customerName: sale.customer.name };

    } else {
      // For all other categories, description is required, and name is derived
      if (!description) {
        throw new ApiError(400, "A description is required for this expense category.");
      }
      finalDescription = description;
      transactionName = category; // Set the transaction name to the category itself
    }

    // 4. Update Account Balance and Create Transaction
    account.balance -= amount;
    await account.save({ session });

    const newTransaction = new Transaction({ accountId, date: new Date(), transactionType: "Expense", amount, name: transactionName, source: "Manual", paymentMethod, description: finalDescription, category, reference, referenceModel, miscReference });
    await newTransaction.save({ session });

    await session.commitTransaction();
    session.endSession();

    return res.status(201).json(new ApiResponse(201, newTransaction, "Expense added successfully."));
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    next(error instanceof ApiError ? error : new ApiError(500, "An internal server error occurred."));
  }
}

// @desc    Function to be called by a cron job to auto-close daily cash
async function autoCloseDailyCashForCron() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const openSession = await DailyCash.findOne({ date: today, status: "Open" });

  if (openSession) {
    try {
      const metrics = await _calculateDailyCashMetrics(today.toISOString());
      const finalRunningBalance = metrics.runningBalance;

      openSession.status = "Closed";
      const endOfDay = new Date();
      endOfDay.setHours(23, 59, 59, 999);
      openSession.closedAt = endOfDay;
      openSession.closingBalance = finalRunningBalance;
      await openSession.save();
      console.log(`Successfully auto-closed daily cash for ${today.toDateString()} via cron job.`);
    } catch (error) {
      console.error(`Error auto-closing daily cash for ${today.toDateString()} via cron job:`, error);
    }
  }
}

// @desc    Function to be called on server startup to close any missed daily cash entries
async function closeMissedDailyCashEntries() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  try {
    const missedEntries = await DailyCash.find({ date: { $lt: today }, status: "Open" });

    if (missedEntries.length > 0) {
      console.log(`Found ${missedEntries.length} missed daily cash entries to close.`);
      for (const entry of missedEntries) {
        try {
          const metrics = await _calculateDailyCashMetrics(entry.date.toISOString());
          entry.status = "Closed";
          const endOfDay = new Date(entry.date);
          endOfDay.setHours(23, 59, 59, 999);
          entry.closedAt = endOfDay;
          entry.closingBalance = metrics.runningBalance;
          await entry.save();
          console.log(`Successfully closed missed daily cash for ${entry.date.toDateString()}.`);
        } catch (error) {
          console.error(`Error closing missed daily cash for ${entry.date.toDateString()}:`, error);
        }
      }
    } else {
      console.log("No missed daily cash entries found on startup.");
    }
  } catch (error) {
    console.error("Error finding missed daily cash entries:", error);
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
};