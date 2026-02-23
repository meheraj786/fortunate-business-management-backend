const DailyCash = require("../models/dailyCash.model");
const Transaction = require("../models/transaction.model");
const Account = require("../models/account.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const logger = require("../utils/logger");
const mongoose = require("mongoose");
const Trash = require("../models/trash.model");
const { startOfDay, endOfDay, now } = require("../utils/timezone.util");
const { formatAccountLabel } = require("../utils/format.util");
const mathUtil = require("../utils/math.util");
const auditService = require("../services/audit.service");

// @desc    Open a new cash session for the current day
// @route   POST /api/cash/open
// @access  Private (Admin)
async function openCash(req, res, next) {
  try {
    // 1. Validate date: Only allow opening for the current day
    const today = startOfDay(now(), req.businessTimezone);

    const requestedDate = req.body.date
      ? startOfDay(new Date(req.body.date), req.businessTimezone)
      : today;

    if (requestedDate.getTime() !== today.getTime()) {
      return next(
        new ApiError(400, "Cash can only be opened for the current day."),
      );
    }

    // 2. Check if cash for today is already open
    const openSession = await DailyCash.findOne({
      date: today,
      status: "Open",
    });
    if (openSession) {
      return next(
        new ApiError(
          400,
          `Daily cash for ${today.toDateString()} is already open.`,
        ),
      );
    }

    // 3. Calculate opening balance
    let openingBalance;
    const lastSessionToday = await DailyCash.findOne({ date: today }).sort({
      createdAt: -1,
    });

    if (lastSessionToday) {
      // This is a reopening on the same day. Opening balance is the last closing balance.
      openingBalance = lastSessionToday.closingBalance;
    } else {
      // This is the first opening of the day. Check for the LAST recorded session (could be yesterday, or 3 days ago).
      const lastSession = await DailyCash.findOne({
        date: { $lt: today },
      }).sort({ date: -1 });

      if (lastSession) {
        if (lastSession.status === "Open") {
          // If the last session was left open, we need to calculate its running balance and close it.
          const lastSessionDate = new Date(lastSession.date);
          const lastSessionMetrics = await _calculateDailyCashMetrics(
            lastSessionDate.toISOString(),
            req.businessTimezone
          );
          openingBalance = lastSessionMetrics.runningBalance; // Today's opening is the last session's running balance

          // Auto-close the last session
          lastSession.status = "Closed";
          const endOfLastSessionDate = endOfDay(
            lastSessionDate,
            req.businessTimezone
          );
          lastSession.closedAt = endOfLastSessionDate;
          lastSession.closingBalance = openingBalance;
          await lastSession.save();
          logger.info(
            `Auto-closed daily cash for ${lastSessionDate.toDateString()}.`,
          );
        } else {
          // The last session was closed properly
          openingBalance = lastSession.closingBalance;
        }
      } else {
        // No session found before today. This is the very first opening in the system.
        // Sum only Cash account balances as the very first opening balance
        const totalAccountBalance = await Account.aggregate([
          { $match: { accountType: "Cash" } },
          { $group: { _id: null, totalBalance: { $sum: "$balance" } } },
        ]);
        openingBalance =
          totalAccountBalance.length > 0
            ? totalAccountBalance[0].totalBalance
            : 0;
      }
    }

    if (typeof openingBalance === "undefined") {
      return next(new ApiError(500, "Could not determine opening balance."));
    }

    // 4. Create new DailyCash session for today
    const newDailyCashSession = await DailyCash.create({
      date: today,
      status: "Open",
      openingBalance: openingBalance,
      openedAt: now(),
      createdBy: req.user?._id || null, // Opened by
    });

    auditService.log({
      action: "OPEN",
      module: "DailyCash",
      documentId: newDailyCashSession._id,
      userId: req.user?._id,
      description: `Opened daily cash for ${today.toDateString()} with opening balance ${openingBalance}`,
      req,
    });

    return res
      .status(201)
      .json(
        new ApiResponse(
          201,
          newDailyCashSession,
          `Daily cash for ${today.toDateString()} opened successfully with an opening balance of ${openingBalance}.`,
        ),
      );
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true) - unlikely for dailyCash model
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A document with the same ${field} '${value}' already exists.`,
        ),
      ); // Generic message
    }
    // Handle Mongoose validation errors
    if (error.name === "ValidationError") {
      const firstErrorField = Object.keys(error.errors)[0];
      let userFriendlyMessage = "Validation failed.";

      if (firstErrorField) {
        userFriendlyMessage = `The field ${firstErrorField} is required.`;
      }
      return next(new ApiError(400, userFriendlyMessage, error.errors));
    }
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
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

    const targetDate = startOfDay(new Date(date), req.businessTimezone);

    // 1. Find the currently open session for the target date
    const openSession = await DailyCash.findOne({
      date: targetDate,
      status: "Open",
    });

    if (!openSession) {
      return next(
        new ApiError(
          404,
          `No open daily cash session found for ${targetDate.toDateString()} to close.`,
        ),
      );
    }

    // 2. Calculate final running balance for the WHOLE day
    const metrics = await _calculateDailyCashMetrics(
      targetDate.toISOString(),
      req.businessTimezone,
    );
    const finalRunningBalance = metrics.runningBalance;

    // 3. Update the open session document
    openSession.status = "Closed";
    openSession.closedAt = now();
    openSession.closingBalance = finalRunningBalance;
    openSession.modifiedBy = req.user?._id || null; // Closed by
    await openSession.save();

    // 4. Recalculate metrics to get the final state with the closed session
    const finalMetrics = await _calculateDailyCashMetrics(
      targetDate.toISOString(),
      req.businessTimezone,
    );

    auditService.log({
      action: "CLOSE",
      module: "DailyCash",
      documentId: openSession._id,
      userId: req.user?._id,
      description: `Closed daily cash for ${targetDate.toDateString()} with closing balance ${finalRunningBalance}`,
      req,
    });

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          finalMetrics,
          `Daily cash for ${targetDate.toDateString()} closed successfully with a closing balance of ${finalRunningBalance}.`,
        ),
      );
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true) - unlikely for dailyCash model
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A document with the same ${field} '${value}' already exists.`,
        ),
      ); // Generic message
    }
    // Handle Mongoose validation errors
    if (error.name === "ValidationError") {
      const firstErrorField = Object.keys(error.errors)[0];
      let userFriendlyMessage = "Validation failed.";

      if (firstErrorField) {
        userFriendlyMessage = `The field ${firstErrorField} is required.`;
      }
      return next(new ApiError(400, userFriendlyMessage, error.errors));
    }
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
}

// @desc    Get the status of the last cash session for a specific date
// @route   GET /api/cash/status/:date
// @access  Private
async function getDailyCashStatus(req, res, next) {
  try {
    const { date } = req.query;
    if (!date) {
      return next(
        new ApiError(400, "Date is required to get daily cash status."),
      );
    }

    const targetDate = startOfDay(new Date(date), req.businessTimezone);

    // Find the last session for the date to determine the current status
    const lastSession = await DailyCash.findOne({ date: targetDate }).sort({
      createdAt: -1,
    });

    if (lastSession) {
      return res
        .status(200)
        .json(
          new ApiResponse(
            200,
            { status: lastSession.status, date: lastSession.date },
            `Daily cash status for ${targetDate.toDateString()} fetched successfully.`,
          ),
        );
    } else {
      return res
        .status(200)
        .json(
          new ApiResponse(
            200,
            { status: "Not Opened Yet", date: targetDate },
            `Daily cash for ${targetDate.toDateString()} has not been opened yet.`,
          ),
        );
    }
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true) - unlikely for dailyCash model
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A document with the same ${field} '${value}' already exists.`,
        ),
      ); // Generic message
    }
    // Handle Mongoose validation errors
    if (error.name === "ValidationError") {
      const firstErrorField = Object.keys(error.errors)[0];
      let userFriendlyMessage = "Validation failed.";

      if (firstErrorField) {
        userFriendlyMessage = `The field ${firstErrorField} is required.`;
      }
      return next(new ApiError(400, userFriendlyMessage, error.errors));
    }
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
}

// Helper function to calculate daily cash metrics for a whole day
async function _calculateDailyCashMetrics(dateString, timezone) {
  const targetDate = startOfDay(new Date(dateString), timezone);
  const nextDay = new Date(endOfDay(targetDate, timezone).getTime() + 1);

  // Get all sessions for the target date, sorted by creation time
  const sessions = await DailyCash.find({ date: targetDate }).sort({
    createdAt: "asc",
  });

  let openingBalance = 0;
  let status = "Not Opened Yet";

  if (sessions.length > 0) {
    // The day's opening balance is the opening balance of the very first session
    openingBalance = sessions[0].openingBalance;
    // The day's overall status is the status of the very last session
    status = sessions[sessions.length - 1].status;
  } else {
    // If no sessions for today, calculate opening balance from the most recent previous session
    const lastPreviousSession = await DailyCash.findOne({
      date: { $lt: targetDate },
    }).sort({ date: -1, createdAt: -1 });

    if (lastPreviousSession) {
      if (lastPreviousSession.status === "Closed") {
        openingBalance = lastPreviousSession.closingBalance || 0;
      } else if (lastPreviousSession.status === "Open") {
        // This case should ideally be handled by the startup/cron jobs, but as a fallback:
        const prevDayMetrics = await _calculateDailyCashMetrics(
          lastPreviousSession.date.toISOString(),
          timezone,
        );
        openingBalance = prevDayMetrics.runningBalance;
      }
    } else {
      // Very first entry in the system logic
      const firstEverEntry = await DailyCash.findOne().sort({
        createdAt: "asc",
      });
      if (!firstEverEntry) {
        // CHANGED: Only consider Cash accounts for the very first opening balance
        const totalAccountBalance = await Account.aggregate([
          { $match: { accountType: "Cash" } },
          { $group: { _id: null, totalBalance: { $sum: "$balance" } } },
        ]);
        openingBalance =
          totalAccountBalance.length > 0
            ? totalAccountBalance[0].totalBalance
            : 0;
      }
    }
  }

  // --- Enriched Transaction Aggregation ---
  const transactionStatsPipeline = [
    {
      $match: {
        date: { $gte: targetDate, $lt: nextDay },
        isDeleted: { $ne: true }, // Ensure deleted transactions are excluded
      },
    },
    // ** Start of Enrichment **
    {
      $lookup: {
        from: "accounts",
        localField: "accountId",
        foreignField: "_id",
        as: "accountId",
      },
    },
    {
      $lookup: {
        from: "sales",
        localField: "reference",
        foreignField: "_id",
        as: "saleRef",
      },
    },
    {
      $lookup: {
        from: "lcs",
        localField: "reference",
        foreignField: "_id",
        as: "lcRef",
      },
    },
    { $unwind: { path: "$accountId", preserveNullAndEmptyArrays: true } },
    { $unwind: { path: "$saleRef", preserveNullAndEmptyArrays: true } },
    { $unwind: { path: "$lcRef", preserveNullAndEmptyArrays: true } },
    {
      $addFields: {
        reference: {
          $cond: {
            if: { $eq: ["$referenceModel", "Sale"] },
            then: "$saleRef",
            else: "$lcRef",
          },
        },
      },
    },
    { $project: { saleRef: 0, lcRef: 0 } }, // Clean up
    // ** End of Enrichment **
    { $sort: { date: -1 } }, // Sort transactions descending by date
    {
      $group: {
        _id: null,
        // Business Metrics (All payment methods, EXCLUDING Transfers)
        totalIncome: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ["$transactionType", "Income"] },
                  { $ne: ["$category", "Transfer In"] }, // Exclude Transfers
                ],
              },
              "$amount",
              0,
            ],
          },
        },
        totalExpenses: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ["$transactionType", "Expense"] },
                  { $ne: ["$category", "Transfer Out"] }, // Exclude Transfers
                ],
              },
              "$amount",
              0,
            ],
          },
        },
        // Cash Metrics (Liquidity - Includes Transfers)
        totalCashIncome: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ["$transactionType", "Income"] },
                  { $eq: ["$paymentMethod", "Cash"] },
                ],
              },
              "$amount",
              0,
            ],
          },
        },
        totalCashExpenses: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ["$transactionType", "Expense"] },
                  { $eq: ["$paymentMethod", "Cash"] },
                ],
              },
              "$amount",
              0,
            ],
          },
        },
        // Business Cash Metrics (Performance - Excludes Transfers)
        totalBusinessCashIncome: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ["$transactionType", "Income"] },
                  { $eq: ["$paymentMethod", "Cash"] },
                  { $ne: ["$category", "Transfer In"] },
                ],
              },
              "$amount",
              0,
            ],
          },
        },
        totalBusinessCashExpenses: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ["$transactionType", "Expense"] },
                  { $eq: ["$paymentMethod", "Cash"] },
                  { $ne: ["$category", "Transfer Out"] },
                ],
              },
              "$amount",
              0,
            ],
          },
        },
        // Transaction Counts
        totalIncomeTransactionsCount: {
          $sum: {
            $cond: [{ $eq: ["$transactionType", "Income"] }, 1, 0],
          },
        },
        totalExpenseTransactionsCount: {
          $sum: {
            $cond: [{ $eq: ["$transactionType", "Expense"] }, 1, 0],
          },
        },
        transactions: { $push: "$$ROOT" },
      },
    },
  ];

  const transactionResults = await Transaction.aggregate(
    transactionStatsPipeline,
  );

  let totalIncome = 0;
  let totalExpenses = 0;
  let totalCashIncome = 0;
  let totalCashExpenses = 0;
  let totalBusinessCashIncome = 0;
  let totalBusinessCashExpenses = 0;
  let transactions = [];
  let totalIncomeTransactionsCount = 0;
  let totalExpenseTransactionsCount = 0;

  if (transactionResults.length > 0) {
    totalIncome = transactionResults[0].totalIncome;
    totalExpenses = transactionResults[0].totalExpenses;
    totalCashIncome = transactionResults[0].totalCashIncome;
    totalCashExpenses = transactionResults[0].totalCashExpenses;
    totalBusinessCashIncome = transactionResults[0].totalBusinessCashIncome;
    totalBusinessCashExpenses = transactionResults[0].totalBusinessCashExpenses;
    transactions = transactionResults[0].transactions;
    totalIncomeTransactionsCount =
      transactionResults[0].totalIncomeTransactionsCount;
    totalExpenseTransactionsCount =
      transactionResults[0].totalExpenseTransactionsCount;
  }
  // --- End of Aggregation ---

  // Running balance is based on the day's starting opening balance + CASH ONLY transactions (Liquidity)
  // This ensures "Cash In Hand" is accurate regardless of Bank/Mobile transactions
  // const runningBalance = openingBalance + totalCashIncome - totalCashExpenses;
  const runningBalance = mathUtil.add(openingBalance, mathUtil.sub(totalCashIncome, totalCashExpenses));

  return {
    date: targetDate,
    status, // Status of the last session
    openingBalance, // Opening balance of the first session
    // Business Metrics
    totalIncome,
    totalExpenses,
    // Cash Metrics (Liquidity)
    totalCashIncome,
    totalCashExpenses,
    // Business Cash Metrics (Performance)
    totalBusinessCashIncome,
    totalBusinessCashExpenses,
    // Result
    runningBalance, // Pure Cash Balance
    totalIncomeTransactionsCount,
    totalExpenseTransactionsCount,
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
      return next(
        new ApiError(400, "Date is required to get daily cash summary."),
      );
    }
    const metrics = await _calculateDailyCashMetrics(
      date,
      req.businessTimezone,
    );
    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          metrics,
          `Daily cash summary for ${new Date(date).toDateString()} fetched successfully.`,
        ),
      );
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true) - unlikely for dailyCash model
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A document with the same ${field} '${value}' already exists.`,
        ),
      ); // Generic message
    }
    // Handle Mongoose validation errors
    if (error.name === "ValidationError") {
      const firstErrorField = Object.keys(error.errors)[0];
      let userFriendlyMessage = "Validation failed.";

      if (firstErrorField) {
        userFriendlyMessage = `The field ${firstErrorField} is required.`;
      }
      return next(new ApiError(400, userFriendlyMessage, error.errors));
    }
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
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
    const today = startOfDay(now(), req.businessTimezone);
    const openSession = await DailyCash.findOne({
      date: today,
      status: "Open",
    });

    if (!openSession) {
      throw new ApiError(400, "Daily cash is closed. Cannot add income.");
    }

    // 2. Validate input
    const validationErrors = [];
    if (!amount || amount <= 0)
      validationErrors.push({
        field: "amount",
        message: "Amount is required and must be positive.",
      });
    if (!category)
      validationErrors.push({
        field: "category",
        message: "Category is required.",
      });
    if (!name)
      validationErrors.push({
        field: "name",
        message: "Income name is required.",
      });
    if (!paymentMethod)
      validationErrors.push({
        field: "paymentMethod",
        message: "Payment method is required.",
      });
    if (!accountId)
      validationErrors.push({
        field: "accountId",
        message: "Account ID is required for payment.",
      });

    if (validationErrors.length > 0) {
      throw new ApiError(400, validationErrors[0].message, validationErrors);
    }

    const account = await Account.findById(accountId).session(session);
    if (!account) throw new ApiError(404, "Account not found.");
    if (account.accountType !== paymentMethod) {
      throw new ApiError(
        400,
        `Payment method '${paymentMethod}' requires a matching account type.`,
      );
    }

    let finalDescription = description;
    let reference = null;
    let referenceModel = null;
    let miscReference = {};
    const incomeCategories = [
      "LC",
      "Sales",
      "Donation",
      "Commission",
      "Interest",
      "Service Charge",
      "Others",
    ];
    if (!incomeCategories.includes(category))
      throw new ApiError(400, "Invalid income category.");

    if (category === "LC") {
      if (!lcId) {
        throw new ApiError(400, "LC ID is mandatory for LC income category.");
      }
      const lc = await LC.findById(lcId);
      if (!lc) {
        throw new ApiError(404, "LC not found.");
      }
      // Updated description format for LC income
      finalDescription = `${name} Income from LC Number: ${lc.basicInfo.lcNumber} via ${paymentMethod} Account: ${formatAccountLabel(account)}.`;
      reference = lcId;
      referenceModel = "LC";
      miscReference = { lcNumber: lc.basicInfo.lcNumber };
    } else if (category === "Sales") {
      if (!salesId) {
        throw new ApiError(
          400,
          "Sales ID is mandatory for Sales income category.",
        );
      }
      const sale = await Sale.findById(salesId);
      if (!sale) {
        throw new ApiError(404, "Sale not found.");
      }
      // Updated description format for Sales income
      finalDescription = `${name} Income from Sale ID: ${sale.saleId} (Customer: ${sale.customer.name}) via ${paymentMethod} Account: ${formatAccountLabel(account)}.`;
      reference = salesId;
      referenceModel = "Sale";
      miscReference = { saleId: sale.saleId, customerName: sale.customer.name };
    } else {
      if (!description) {
        throw new ApiError(
          400,
          "Description is required for this income category.",
        );
      }
      finalDescription = `${description} via ${paymentMethod} Account: ${formatAccountLabel(account)}.`;
    }

    // 3. Update Account Balance
    // account.balance += amount;
    account.balance = mathUtil.add(account.balance, amount);
    account.modifiedBy = req.user?._id || null;
    await account.save({ session });

    const newTransaction = new Transaction({
      accountId,
      date: now(),
      transactionType: "Income",
      amount,
      name,
      source: "Manual",
      paymentMethod,
      description: finalDescription,
      category,
      reference,
      referenceModel,
      miscReference,
      createdBy: req.user?._id || null,
    });
    await newTransaction.save({ session });

    await session.commitTransaction();
    session.endSession();

    auditService.log({
      action: "CREATE",
      module: "DailyCash",
      documentId: newTransaction._id,
      userId: req.user?._id,
      description: `Added income "${name}" of ${amount} via ${paymentMethod}`,
      metadata: { amount, category, paymentMethod },
      req,
    });

    return res
      .status(201)
      .json(new ApiResponse(201, newTransaction, "Income added successfully."));
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    if (error instanceof ApiError) {
      // This handles custom ApiError thrown earlier in the function
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true) - unlikely for dailyCash model
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A document with the same ${field} '${value}' already exists.`,
        ),
      ); // Generic message
    }
    // Handle Mongoose validation errors
    if (error.name === "ValidationError") {
      const firstErrorField = Object.keys(error.errors)[0];
      let userFriendlyMessage = "Validation failed.";

      if (firstErrorField) {
        userFriendlyMessage = `The field ${firstErrorField} is required.`;
      }
      return next(new ApiError(400, userFriendlyMessage, error.errors));
    }
    // Fallback for any other unexpected errors
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
}

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
      name,
      paymentMethod,
      accountId,
      description,
      lcId,
      salesId,
      lcCostCategory,
    } = req.body;

    // 1. Gatekeeper: Check if Daily Cash for today is Open
    const today = startOfDay(now(), req.businessTimezone);
    const openSession = await DailyCash.findOne({
      date: today,
      status: "Open",
    });
    if (!openSession)
      throw new ApiError(400, "Daily cash is closed. Cannot add expense.");

    // 2. Universal Validation
    const validationErrors = [];
    if (!amount || amount <= 0)
      validationErrors.push({
        field: "amount",
        message: "Amount is required and must be positive.",
      });
    if (!category)
      validationErrors.push({
        field: "category",
        message: "Category is required.",
      });
    if (!paymentMethod)
      validationErrors.push({
        field: "paymentMethod",
        message: "Payment method is required.",
      });
    if (!accountId)
      validationErrors.push({
        field: "accountId",
        message: "Account ID is required for payment.",
      });

    if (validationErrors.length > 0) {
      throw new ApiError(400, validationErrors[0].message, validationErrors);
    }

    const account = await Account.findById(accountId).session(session);
    if (!account) throw new ApiError(404, "Account not found.");
    if (account.accountType !== paymentMethod)
      throw new ApiError(
        400,
        "Payment method requires a matching account type.",
      );
    if (account.balance < amount)
      throw new ApiError(
        400,
        `Insufficient balance in ${account.accountName}.`,
      );

    let finalDescription = description;
    let transactionName = name; // Default to user-provided name
    let reference = null;
    let referenceModel = null;
    let miscReference = {};
    const expenseCategories = [
      "LC",
      "Sales",
      "Rent",
      "Salary",
      "Office Expense",
      "Transport",
      "Utility",
      "Others",
    ];
    if (!expenseCategories.includes(category))
      throw new ApiError(400, "Invalid expense category.");

    // 3. Category-Specific Logic
    if (category === "LC") {
      if (!name)
        throw new ApiError(400, "An expense name is required for LC expenses.");
      if (!lcId)
        throw new ApiError(400, "LC ID is mandatory for an LC expense.");
      const lc = await LC.findById(lcId).session(session);
      if (!lc) throw new ApiError(404, "LC not found.");

      const validLCCategories = [
        "financialInfo",
        "shippingCustomsInfo",
        "agentTransportInfo",
        "otherExpenses",
      ];
      const targetLCCostCategory =
        lcCostCategory && validLCCategories.includes(lcCostCategory)
          ? lcCostCategory
          : "otherExpenses";

      if (!lc[targetLCCostCategory]) lc[targetLCCostCategory] = { costs: [] };
      else if (!lc[targetLCCostCategory].costs)
        lc[targetLCCostCategory].costs = [];

      lc[targetLCCostCategory].costs.push({
        name: name,
        amount,
        date: now(),
        paymentMethod,
        accountId,
      });
      await lc.save({ session });

      finalDescription = `Expense for LC: ${lc.basicInfo.lcNumber}, Cost: ${name} via ${paymentMethod} Account: ${formatAccountLabel(account)}.`;
      reference = lcId;
      referenceModel = "LC";
      miscReference = {
        costName: name,
        lcNumber: lc.basicInfo.lcNumber,
        lcCostCategory: targetLCCostCategory,
      };
    } else if (category === "Sales") {
      if (!name)
        throw new ApiError(
          400,
          "An expense name is required for Sales expenses.",
        );
      if (!salesId)
        throw new ApiError(400, "Sales ID is mandatory for a Sales expense.");
      const sale = await Sale.findById(salesId).session(session);
      if (!sale) throw new ApiError(404, "Sale not found.");

      sale.costs.push({
        name: name,
        amount,
        date: req.body.date ? new Date(req.body.date) : now(),
        accountId,
        paymentMethod,
      });
      await sale.save({ session }); // Let pre-save hook handle paymentStatus

      finalDescription = `Expense for Sale: ${sale.saleId}, Cost: ${name} via ${paymentMethod} Account: ${formatAccountLabel(account)}.`;
      reference = salesId;
      referenceModel = "Sale";
      miscReference = {
        costName: name,
        saleId: sale.saleId,
        customerName: sale.customer.name,
      };
    } else {
      // For all other categories, description is required, and name is derived
      if (!description) {
        throw new ApiError(
          400,
          "A description is required for this expense category.",
        );
      }
      if (!name) {
        throw new ApiError(
          400,
          "Expense name is required for this category.",
        );
      }
      finalDescription = `${description} via ${paymentMethod} Account: ${formatAccountLabel(account)}.`;
      transactionName = name; // Use user-provided name instead of category
    }

    // 4. Update Account Balance and Create Transaction
    // account.balance -= amount;
    account.balance = mathUtil.sub(account.balance, amount);
    account.modifiedBy = req.user?._id || null;
    await account.save({ session });

    const newTransaction = new Transaction({
      accountId,
      date: now(),
      transactionType: "Expense",
      amount,
      name: transactionName,
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

    auditService.log({
      action: "CREATE",
      module: "DailyCash",
      documentId: newTransaction._id,
      userId: req.user?._id,
      description: `Added expense "${transactionName}" of ${amount} via ${paymentMethod}`,
      metadata: { amount, category, paymentMethod },
      req,
    });

    return res
      .status(201)
      .json(
        new ApiResponse(201, newTransaction, "Expense added successfully."),
      );
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    if (error instanceof ApiError) {
      // This handles custom ApiError thrown earlier in the function
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true) - unlikely for dailyCash model
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A document with the same ${field} '${value}' already exists.`,
        ),
      ); // Generic message
    }
    // Handle Mongoose validation errors
    if (error.name === "ValidationError") {
      const firstErrorField = Object.keys(error.errors)[0];
      let userFriendlyMessage = "Validation failed.";

      if (firstErrorField) {
        userFriendlyMessage = `The field ${firstErrorField} is required.`;
      }
      return next(new ApiError(400, userFriendlyMessage, error.errors));
    }
    // Fallback for any other unexpected errors
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
}

// @desc    Function to be called by a cron job to auto-close daily cash
async function autoCloseDailyCashForCron() {
  const today = startOfDay(now());

  const openSession = await DailyCash.findOne({ date: today, status: "Open" });

  if (openSession) {
    try {
      const metrics = await _calculateDailyCashMetrics(today.toISOString());
      const finalRunningBalance = metrics.runningBalance;

      openSession.status = "Closed";
      const endOfToday = endOfDay(now());
      openSession.closedAt = endOfToday;
      openSession.closingBalance = finalRunningBalance;
      await openSession.save();
      logger.info(
        `Successfully auto-closed daily cash for ${today.toDateString()} via cron job.`,
      );
    } catch (error) {
      logger.error(
        `Error auto-closing daily cash for ${today.toDateString()} via cron job:`,
        error,
      );
    }
  }
}

// @desc    Function to be called on server startup to close any missed daily cash entries
async function closeMissedDailyCashEntries() {
  const today = startOfDay(now());

  try {
    const missedEntries = await DailyCash.find({
      date: { $lt: today },
      status: "Open",
    });

    if (missedEntries.length > 0) {
      logger.info(
        `Found ${missedEntries.length} missed daily cash entries to close.`,
      );
      for (const entry of missedEntries) {
        try {
          const metrics = await _calculateDailyCashMetrics(
            entry.date.toISOString(),
          );
          entry.status = "Closed";
          const endOfEntryDate = endOfDay(new Date(entry.date));
          entry.closedAt = endOfEntryDate;
          entry.closingBalance = metrics.runningBalance;
          await entry.save();
          logger.info(
            `Successfully closed missed daily cash for ${entry.date.toDateString()}.`,
          );
        } catch (error) {
          logger.error(
            `Error closing missed daily cash for ${entry.date.toDateString()}:`,
            error,
          );
        }
      }
    } else {
      logger.info("No missed daily cash entries found on startup.");
    }
  } catch (error) {
    logger.error("Error finding missed daily cash entries:", error);
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
