const DailyCash = require("../models/dailyCash.model");
const Transaction = require("../models/transaction.model");
const Account = require("../models/account.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const mongoose = require("mongoose"); // Add this line


// @desc    Open the cash for the current day
// @route   POST /api/cash/open
// @access  Private (Admin)
async function openCash(req, res, next) {
  try {
    // 1. Validate date: Only allow opening for the current day
    const today = new Date();
    today.setHours(0, 0, 0, 0); // Normalize to start of day

    const requestedDate = req.body.date ? new Date(req.body.date) : today;
    requestedDate.setHours(0, 0, 0, 0);

    if (requestedDate.getTime() !== today.getTime()) {
      return next(new ApiError(400, "Cash can only be opened for the current day."));
    }

    // 2. Check if cash for today is already open
    let dailyCashForToday = await DailyCash.findOne({ date: today });
    if (dailyCashForToday && dailyCashForToday.status === "Open") {
      return next(new ApiError(400, `Daily cash for ${today.toDateString()} is already open.`));
    }
    if (dailyCashForToday && dailyCashForToday.status === "Closed") {
      return next(new ApiError(400, `Daily cash for ${today.toDateString()} is already closed and cannot be reopened.`));
    }

    // 3. Auto-close previous day if forgotten
    const previousDay = new Date(today);
    previousDay.setDate(today.getDate() - 1);
    previousDay.setHours(0, 0, 0, 0);

    const prevDayCash = await DailyCash.findOne({ date: previousDay });
    if (prevDayCash && prevDayCash.status === "Open") {
      // Calculate running balance for previous day to set its closing balance
      const prevDayMetrics = await _calculateDailyCashMetrics(previousDay.toISOString());
      prevDayCash.status = "Closed";
      prevDayCash.closedAt = new Date();
      prevDayCash.closingBalance = prevDayMetrics.runningBalance;
      await prevDayCash.save();
      console.log(`Auto-closed daily cash for ${previousDay.toDateString()}.`);
    }

    // 4. Calculate today's opening balance
    const todayMetrics = await _calculateDailyCashMetrics(today.toISOString());
    const openingBalance = todayMetrics.openingBalance;

    // 5. Create new DailyCash entry for today
    dailyCashForToday = await DailyCash.create({
      date: today,
      status: "Open",
      openingBalance: openingBalance,
      openedAt: new Date(),
    });

    return res
      .status(201)
      .json(new ApiResponse(201, dailyCashForToday, `Daily cash for ${today.toDateString()} opened successfully with an opening balance of ${openingBalance}.`));
  } catch (error) {
    next(new ApiError(500, error.message || "Error opening daily cash."));
  }
}

// @desc    Close the cash for a specific day
// @route   POST /api/cash/close
// @access  Private (Admin)
async function closeCash(req, res, next) {
  try {
    const { date } = req.body;
    if (!date) {
      return next(new ApiError(400, "Date is required to close daily cash."));
    }

    const targetDate = new Date(date);
    targetDate.setHours(0, 0, 0, 0); // Normalize to start of day

    const dailyCash = await DailyCash.findOne({ date: targetDate });

    // 1. Validate DailyCash existence and status
    if (!dailyCash) {
      return next(new ApiError(404, `Daily cash for ${targetDate.toDateString()} not found. Cannot close.`));
    }
    if (dailyCash.status === "Closed") {
      return next(new ApiError(400, `Daily cash for ${targetDate.toDateString()} is already closed.`));
    }

    // 2. Calculate final running balance for the day
    const metrics = await _calculateDailyCashMetrics(targetDate.toISOString());
    const finalRunningBalance = metrics.runningBalance;

    // 3. Update DailyCash document
    dailyCash.status = "Closed";
    dailyCash.closedAt = new Date();
    dailyCash.closingBalance = finalRunningBalance;
    await dailyCash.save();

    return res
      .status(200)
      .json(new ApiResponse(200, dailyCash, `Daily cash for ${targetDate.toDateString()} closed successfully with a closing balance of ${finalRunningBalance}.`));
  } catch (error) {
    next(new ApiError(500, error.message || "Error closing daily cash."));
  }
}

// @desc    Get the status of daily cash for a specific date
// @route   GET /api/cash/status/:date
// @access  Private
async function getDailyCashStatus(req, res, next) {
  try {
    const { date } = req.query; // Date is passed as a query parameter
    if (!date) {
      return next(new ApiError(400, "Date is required to get daily cash status."));
    }

    const targetDate = new Date(date);
    targetDate.setHours(0, 0, 0, 0); // Normalize to start of day

    const dailyCash = await DailyCash.findOne({ date: targetDate });

    if (dailyCash) {
      return res
        .status(200)
        .json(
          new ApiResponse(
            200,
            { status: dailyCash.status, date: dailyCash.date },
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

// @desc    Get a summary of daily cash for a specific date
// @route   GET /api/cash/summary/:date
// @access  Private
// Helper function to calculate daily cash metrics
async function _calculateDailyCashMetrics(dateString) {
  const targetDate = new Date(dateString);
  targetDate.setHours(0, 0, 0, 0); // Normalize to start of day
  const nextDay = new Date(targetDate);
  nextDay.setDate(targetDate.getDate() + 1);

  const dailyCash = await DailyCash.findOne({ date: targetDate });

  let openingBalance = 0;
  let status = "Not Opened Yet"; // Default status if no record
  let currentDailyCashDoc = dailyCash; // The actual DailyCash document found

  if (dailyCash) {
    openingBalance = dailyCash.openingBalance;
    status = dailyCash.status;
  } else {
    // If daily cash not opened for today, calculate opening balance from previous day's closing balance
    const previousDay = new Date(targetDate);
    previousDay.setDate(targetDate.getDate() - 1);
    previousDay.setHours(0, 0, 0, 0);

    const previousDailyCash = await DailyCash.findOne({ date: previousDay });

    if (previousDailyCash && previousDailyCash.status === "Closed") {
      openingBalance = previousDailyCash.closingBalance || 0;
    } else if (previousDailyCash && previousDailyCash.status === "Open") {
      // If previous day cash was open, calculate its running balance to get today's opening balance
      const prevDayMetrics = await _calculateDailyCashMetrics(previousDay.toISOString()); // Recursive call for previous day
      openingBalance = prevDayMetrics.runningBalance;
    } else {
      // If no previous daily cash found and it's the very first entry, sum all account balances
      const firstDailyCashEntry = await DailyCash.findOne().sort({ date: 1 });
      if (!firstDailyCashEntry) {
        const totalAccountBalance = await Account.aggregate([
          {
            $group: {
              _id: null,
              totalBalance: { $sum: "$balance" },
            },
          },
        ]);
        openingBalance = totalAccountBalance.length > 0 ? totalAccountBalance[0].totalBalance : 0;
      }
    }
  }

  const transactions = await Transaction.find({
    date: { $gte: targetDate, $lt: nextDay },
  }).populate("accountId", "accountName accountType"); // Populate account details

  const totalIncome = transactions
    .filter((t) => t.transactionType === "Income")
    .reduce((sum, t) => sum + t.amount, 0);
  const totalExpenses = transactions
    .filter((t) => t.transactionType === "Expense")
    .reduce((sum, t) => sum + t.amount, 0);

  const runningBalance = openingBalance + totalIncome - totalExpenses;

  return {
    date: targetDate,
    status,
    openingBalance,
    totalIncome,
    totalExpenses,
    runningBalance,
    transactions,
    dailyCashDoc: currentDailyCashDoc, // Return the actual DailyCash document as well
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
    return res.status(200).json(new ApiResponse(200, metrics, `Daily cash summary for ${metrics.date.toDateString()} fetched successfully.`));
  } catch (error) {
    next(new ApiError(500, error.message || "Error fetching daily cash summary."));
  }
}

// @desc    Add a manual income transaction
// @route   POST /api/cash/income
// @access  Private
const LC = require("../models/lc.model");
const Sale = require("../models/sales.model");

// @desc    Add a manual income transaction
// @route   POST /api/cash/income
// @access  Private
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
    const dailyCash = await DailyCash.findOne({ date: today });

    if (!dailyCash || dailyCash.status === "Closed") {
      throw new ApiError(400, "Daily cash is closed. Cannot add income.");
    }

    // 2. Validate input
    if (!amount || amount <= 0) {
      throw new ApiError(400, "Amount is required and must be positive.");
    }
    if (!category) {
      throw new ApiError(400, "Category is required.");
    }
    if (!name) {
      throw new ApiError(400, "Income name is required.");
    }
    if (!paymentMethod) {
      throw new ApiError(400, "Payment method is required.");
    }
    if (!accountId) {
      throw new ApiError(400, "Account ID is required for payment.");
    }

    // Validate payment method and account type
    const account = await Account.findById(accountId).session(session);
    if (!account) {
      throw new ApiError(404, "Account not found.");
    }
    if (account.accountType !== paymentMethod) {
      throw new ApiError(
        400,
        `Payment method '${paymentMethod}' requires a '${paymentMethod}' account, but a '${account.accountType}' account was provided.`
      );
    }

    let finalDescription = description;
    let reference = null;
    let referenceModel = null;
    let miscReference = {}; // Initialize miscReference to an empty object
    const incomeCategories = ["LC", "Sales", "Donation", "Commission", "Interest", "Service Charge", "Others"];

    if (!incomeCategories.includes(category)) {
        throw new ApiError(400, `Invalid income category. Must be one of: ${incomeCategories.join(", ")}`);
    }

    if (category === "LC") {
      if (!lcId) {
        throw new ApiError(400, "LC ID is mandatory for LC income category.");
      }
      const lc = await LC.findById(lcId);
      if (!lc) {
        throw new ApiError(404, "LC not found.");
      }
      finalDescription = `Income from LC Number: ${lc.basicInfo.lcNumber} via ${paymentMethod} Account: ${account.accountName}.`;
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
      finalDescription = `Income from Sale ID: ${sale.saleId} (Customer: ${sale.customer.name}) via ${paymentMethod} Account: ${account.accountName}.`;
      reference = salesId;
      referenceModel = "Sale";
      miscReference = { saleId: sale.saleId, customerName: sale.customer.name };
    }

    // 3. Update Account Balance
    account.balance += amount;
    await account.save({ session });

    // 4. Create Transaction
    const newTransaction = new Transaction({
      accountId: accountId,
      date: new Date(), // Auto-generated date
      transactionType: "Income", // Explicitly set transaction type
      amount,
      name,
      source: "Manual",
      paymentMethod,
      description: finalDescription,
      category,
      reference,
      referenceModel,
      miscReference, // Add miscReference here
    });
    await newTransaction.save({ session });

    await session.commitTransaction();
    session.endSession();

    return res
      .status(201)
      .json(new ApiResponse(201, newTransaction, "Income added successfully."));
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    if (error instanceof ApiError) {
      return next(error);
    }
    next(new ApiError(500, error.message || "An internal server error occurred while adding income."));
  }
}

// @desc    Add a manual expense transaction
// @route   POST /api/cash/expense
// @access  Private
// @desc    Add a manual expense transaction
// @route   POST /api/cash/expense
// @access  Private
async function addExpense(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const {
      amount,
      category,
      name, // expense name
      paymentMethod,
      accountId,
      description, // user provided description
      lcId, // optional for LC category
      salesId, // optional for Sales category
      costName, // mandatory for LC/Sales expense categories
    } = req.body;

    // 1. Gatekeeper: Check if Daily Cash for today is Open
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dailyCash = await DailyCash.findOne({ date: today });

    if (!dailyCash || dailyCash.status === "Closed") {
      throw new ApiError(400, "Daily cash is closed. Cannot add expense.");
    }

    // 2. Validate input
    if (!amount || amount <= 0) {
      throw new ApiError(400, "Amount is required and must be positive.");
    }
    if (!category) {
      throw new ApiError(400, "Category is required.");
    }
    if (!name) {
      throw new ApiError(400, "Expense name is required.");
    }
    if (!paymentMethod) {
      throw new ApiError(400, "Payment method is required.");
    }
    if (!accountId) {
      throw new ApiError(400, "Account ID is required for payment.");
    }

    // Validate payment method and account type
    const account = await Account.findById(accountId).session(session);
    if (!account) {
      throw new ApiError(404, "Account not found.");
    }
    if (account.accountType !== paymentMethod) {
      throw new ApiError(
        400,
        `Payment method '${paymentMethod}' requires a '${paymentMethod}' account, but a '${account.accountType}' account was provided.`
      );
    }
    
    // Check for sufficient balance for expense
    if (account.balance < amount) {
        throw new ApiError(400, `Insufficient balance in ${account.accountName} (${account.accountType}) account. Current balance: ${account.balance}.`);
    }

    let finalDescription = description;
    let reference = null;
    let referenceModel = null;
    let miscReference = {};
    const expenseCategories = ["LC", "Sales", "Rent", "Salary", "Office Expense", "Transport", "Utility", "Others"];

    if (!expenseCategories.includes(category)) {
        throw new ApiError(400, `Invalid expense category. Must be one of: ${expenseCategories.join(", ")}`);
    }

    if (category === "LC") {
      if (!lcId) {
        throw new ApiError(400, "LC ID is mandatory for LC expense category.");
      }
      if (!costName) {
        throw new ApiError(400, "Cost name is mandatory for LC expense category.");
      }

      const lc = await LC.findById(lcId).session(session);
      if (!lc) {
        throw new ApiError(404, "LC not found.");
      }

      // Add expense to LC's cost schema
      const newCost = {
        name: costName,
        amount: amount,
        date: new Date(),
        paymentMethod: paymentMethod,
        accountId: accountId,
      };

      if (!lc.otherExpenses) lc.otherExpenses = { costs: [] }; // Default to otherExpenses if no specific section
      if (!lc.otherExpenses.costs) lc.otherExpenses.costs = [];

      // User wants to save it inside LC's cost schema, but didn't specify which one,
      // so I'll add it to otherExpenses for now. A more detailed UI would specify a section.
      lc.otherExpenses.costs.push(newCost);
      await lc.save({ session }); // pre-save hook will update totalCost

      finalDescription = `Expense for LC Number: ${lc.basicInfo.lcNumber}, Cost: ${costName}, Paid via ${paymentMethod} Account: ${account.accountName}.`;
      reference = lcId;
      referenceModel = "LC";
      miscReference = { costName: costName, lcNumber: lc.basicInfo.lcNumber };
    } else if (category === "Sales") {
      if (!salesId) {
        throw new ApiError(400, "Sales ID is mandatory for Sales expense category.");
      }
      if (!costName) {
        throw new ApiError(400, "Cost name is mandatory for Sales expense category.");
      }

      const sale = await Sale.findById(salesId).session(session);
      if (!sale) {
        throw new ApiError(404, "Sale not found.");
      }

      // Add expense to Sale's otherCharges schema
      const newOtherCharge = {
        name: costName,
        amount: amount,
      };
      sale.otherCharges.push(newOtherCharge);

      // Rule: "the sale must become a due sale, and the customer has to pay that amount back."
      // The pre-save hook for sales automatically recalculates totalAmountToBePaid.
      // We also need to ensure paymentStatus reflects "Due payment" if not fully paid.
      sale.paymentStatus = "Due payment"; // Ensure it becomes due if not already
      await sale.save({ session });

      finalDescription = `Expense for Sale ID: ${sale.saleId}, Customer: ${sale.customer.name}, Cost: ${costName}, Paid via ${paymentMethod} Account: ${account.accountName}.`;
      reference = salesId;
      referenceModel = "Sale";
      miscReference = {
        costName: costName,
        saleId: sale.saleId,
        customerName: sale.customer.name,
      };
    }

    // 3. Update Account Balance
    account.balance -= amount;
    await account.save({ session });

    // 4. Create Transaction
    const newTransaction = new Transaction({
      accountId: accountId,
      date: new Date(), // Auto-generated date
      transactionType: "Expense", // Explicitly set transaction type
      amount,
      name,
      source: "Manual",
      paymentMethod,
      description: finalDescription,
      category,
      reference,
      referenceModel,
      miscReference,
    });
    await newTransaction.save({ session });

    await session.commitTransaction();
    session.endSession();

    return res
      .status(201)
      .json(new ApiResponse(201, newTransaction, "Expense added successfully."));
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    if (error instanceof ApiError) {
      return next(error);
    }
    next(new ApiError(500, error.message || "An internal server error occurred while adding expense."));
  }
}



module.exports = {
  openCash,
  closeCash,
  getDailyCashStatus,
  getDailyCashSummary,
  addIncome,
  addExpense,
};