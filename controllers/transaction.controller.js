const Transaction = require("../models/transaction.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const logger = require("../utils/logger");
const Trash = require("../models/trash.model");
const { startOfDay, endOfDay, now } = require("../utils/timezone.util");
const mongoose = require("mongoose");
const Account = require("../models/account.model");
const DailyCash = require("../models/dailyCash.model");
const { moveToTrash } = require("../controllers/trash.controller");
const { formatAccountLabel } = require("../utils/format.util");
const mathUtil = require("../utils/math.util");
const auditService = require("../services/audit.service");
const { escapeRegex } = require("../utils/regex.util");

async function createTransaction(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const {
      accountId,
      date,
      transactionType,
      amount,
      name,
      paymentMethod,
      description,
      category,
    } = req.body;

    // Validate required fields
    if (
      !accountId ||
      !date ||
      !transactionType ||
      !amount ||
      !name ||
      !paymentMethod ||
      !category
    ) {
      throw new ApiError(
        400,
        "All required transaction fields must be provided.",
      );
    }

    const account = await Account.findById(accountId).session(session);
    if (!account) {
      throw new ApiError(404, "Account not found.");
    }

    // DailyCash Gatekeeper Check
    const transactionDate = startOfDay(new Date(date), req.businessTimezone);
    const dailyCash = await DailyCash.findOne({
      date: transactionDate,
      status: "Open",
    }).session(session);

    if (!dailyCash) {
      throw new ApiError(
        400,
        `Daily cash is closed for ${transactionDate.toDateString()}. Cannot create transaction.`,
      );
    }

    if (transactionType === "Income") {
      // account.balance += amount;
      account.balance = mathUtil.add(account.balance, amount);
    } else if (transactionType === "Expense") {
      if (mathUtil.sub(account.balance, amount) < 0) {
        throw new ApiError(400, "Insufficient balance for this expense.");
      }
      // account.balance -= amount;
      account.balance = mathUtil.sub(account.balance, amount);
    } else {
      throw new ApiError(
        400,
        "Invalid transaction type. Must be 'Income' or 'Expense'.",
      );
    }

    await account.save({ session });

    const newTransaction = await Transaction.create(
      [
        {
          accountId,
          date,
          transactionType,
          amount,
          name,
          source: "Manual",
          paymentMethod,
          description,
          category,
          description,
          category,
          isDeleted: false,
          createdBy: req.user?._id || null,
        },
      ],
      { session },
    );

    await session.commitTransaction();
    session.endSession();

    // Audit: Transaction created
    auditService.log({ action: "CREATE", module: "Transaction", documentId: newTransaction[0]._id, userId: req.user?._id, description: `Created ${transactionType} transaction of ${amount} (${name}) in ${account.accountName}`, req });

    return res
      .status(201)
      .json(
        new ApiResponse(
          201,
          newTransaction[0],
          "Transaction created successfully.",
        ),
      );
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    if (error instanceof ApiError) {
      return next(error);
    }
    logger.error("CreateTransaction Error:", error);
    next(new ApiError(500, "Failed to create transaction. Please try again."));
  }
}

async function updateTransaction(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const {
      accountId,
      date,
      transactionType,
      amount,
      name,
      paymentMethod,
      description,
      category,
    } = req.body;

    const transaction = await Transaction.findById(id).session(session);
    if (!transaction) {
      throw new ApiError(404, "Transaction not found.");
    }
    if (transaction.isDeleted) {
      throw new ApiError(400, "Cannot update a deleted transaction.");
    }
    if (transaction.source === "Auto") {
      throw new ApiError(
        400,
        "Cannot update an automatically generated transaction. Please update the source (e.g., Sale, LC) instead.",
      );
    }

    const oldAccountId = transaction.accountId;
    const oldAmount = transaction.amount;
    const oldTransactionType = transaction.transactionType;

    // DailyCash Gatekeeper Check for old and new dates if they differ
    const oldTransactionDate = startOfDay(
      new Date(transaction.date),
      req.businessTimezone,
    );
    const newTransactionDate = startOfDay(new Date(date), req.businessTimezone);
    if (oldTransactionDate.getTime() !== newTransactionDate.getTime()) {
      const newDailyCash = await DailyCash.findOne({
        date: newTransactionDate,
        status: "Open",
      }).session(session);
      if (!newDailyCash) {
        throw new ApiError(
          400,
          `Daily cash is closed for ${newTransactionDate.toDateString()}. Cannot update transaction date.`,
        );
      }
      const oldDailyCash = await DailyCash.findOne({
        date: oldTransactionDate,
        status: "Open",
      }).session(session);
      if (!oldDailyCash) {
        throw new ApiError(
          400,
          `Daily cash is closed for ${oldTransactionDate.toDateString()}. Cannot update transaction as it affects a closed daily cash.`,
        );
      }
    } else {
      const dailyCash = await DailyCash.findOne({
        date: newTransactionDate,
        status: "Open",
      }).session(session);
      if (!dailyCash) {
        throw new ApiError(
          400,
          `Daily cash is closed for ${newTransactionDate.toDateString()}. Cannot update transaction.`,
        );
      }
    }

    const currentAccount =
      await Account.findById(oldAccountId).session(session);
    if (!currentAccount) {
      throw new ApiError(404, "Original account not found.");
    }

    // Reverse the old transaction's effect on the old account
    if (oldTransactionType === "Income") {
      if (mathUtil.sub(currentAccount.balance, oldAmount) < 0) {
        throw new ApiError(
          400,
          `Insufficient balance in ${currentAccount.accountName} to reverse old income.`,
        );
      }
      // currentAccount.balance -= oldAmount;
      currentAccount.balance = mathUtil.sub(currentAccount.balance, oldAmount);
    } else if (oldTransactionType === "Expense") {
      // currentAccount.balance += oldAmount;
      currentAccount.balance = mathUtil.add(currentAccount.balance, oldAmount);
    }
    await currentAccount.save({ session });

    // Apply the new transaction's effect on potentially a new account
    const newAccount = await Account.findById(accountId).session(session);
    if (!newAccount) {
      throw new ApiError(404, "New account not found.");
    }

    if (transactionType === "Income") {
      // newAccount.balance += amount;
      newAccount.balance = mathUtil.add(newAccount.balance, amount);
    } else if (transactionType === "Expense") {
      if (mathUtil.sub(newAccount.balance, amount) < 0) {
        throw new ApiError(400, "Insufficient balance for this new expense.");
      }
      // newAccount.balance -= amount;
      newAccount.balance = mathUtil.sub(newAccount.balance, amount);
    } else {
      throw new ApiError(
        400,
        "Invalid transaction type. Must be 'Income' or 'Expense'.",
      );
    }
    await newAccount.save({ session });

    // Capture snapshot for audit diff
    const transactionSnapshot = transaction.toObject();

    // Update the transaction details
    transaction.accountId = accountId;
    transaction.date = date;
    transaction.transactionType = transactionType;
    transaction.amount = amount;
    transaction.name = name;
    transaction.paymentMethod = paymentMethod;
    transaction.description = description;
    transaction.category = category;
    transaction.modifiedBy = req.user?._id || null;

    await transaction.save({ session });

    await session.commitTransaction();
    session.endSession();

    // Audit: Transaction updated
    auditService.log({ action: "UPDATE", module: "Transaction", documentId: transaction._id, userId: req.user?._id, description: `Updated transaction ${name} (${transactionType}: ${amount})`, changes: auditService.diffChanges(transactionSnapshot, transaction, ["name", "amount", "transactionType", "category", "description"]), req });

    return res
      .status(200)
      .json(
        new ApiResponse(200, transaction, "Transaction updated successfully."),
      );
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    if (error instanceof ApiError) {
      return next(error);
    }
    logger.error("UpdateTransaction Error:", error);
    next(new ApiError(500, "Failed to update transaction. Please try again."));
  }
}

async function getTransactionDetails(req, res, next) {
  try {
    const { id } = req.params; // Transaction ID
    if (!id) {
      return next(new ApiError(400, "Transaction ID is required."));
    }

    const results = await Transaction.aggregate([
      {
        $match: {
          _id: new mongoose.Types.ObjectId(id),
          isDeleted: { $ne: true },
        },
      },
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
          from: "users",
          localField: "createdBy",
          foreignField: "_id",
          as: "creator",
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "modifiedBy",
          foreignField: "_id",
          as: "modifier",
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "deletedBy",
          foreignField: "_id",
          as: "deleter",
        },
      },
      {
        $addFields: {
          createdBy: { $arrayElemAt: ["$creator", 0] },
          modifiedBy: { $arrayElemAt: ["$modifier", 0] },
          deletedBy: { $arrayElemAt: ["$deleter", 0] },
        },
      },
      {
        $project: {
          creator: 0,
          modifier: 0,
          deleter: 0,
          "createdBy.password": 0,
          "modifiedBy.password": 0,
          "deletedBy.password": 0,
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
      {
        $lookup: {
          from: "customers",
          localField: "reference",
          foreignField: "_id",
          as: "customerRef",
        },
      },
      {
        $lookup: {
          from: "advancepayments",
          localField: "reference",
          foreignField: "_id",
          as: "advancePaymentRef",
        },
      },
      { $unwind: { path: "$accountId", preserveNullAndEmptyArrays: true } },
      { $unwind: { path: "$saleRef", preserveNullAndEmptyArrays: true } },
      { $unwind: { path: "$lcRef", preserveNullAndEmptyArrays: true } },
      { $unwind: { path: "$customerRef", preserveNullAndEmptyArrays: true } },
      { $unwind: { path: "$advancePaymentRef", preserveNullAndEmptyArrays: true } },
      {
        $addFields: {
          reference: {
            $switch: {
              branches: [
                { case: { $eq: ["$referenceModel", "Sale"] }, then: "$saleRef" },
                { case: { $eq: ["$referenceModel", "LC"] }, then: "$lcRef" },
                { case: { $eq: ["$referenceModel", "Customer"] }, then: "$customerRef" },
                { case: { $eq: ["$referenceModel", "AdvancePayment"] }, then: "$advancePaymentRef" },
              ],
              default: null,
            },
          },
        },
      },
      { $project: { saleRef: 0, lcRef: 0, customerRef: 0, advancePaymentRef: 0 } }, // Clean up
    ]);

    if (results.length === 0) {
      return next(new ApiError(404, "Transaction not found."));
    }
    const transaction = results[0];

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          transaction,
          "Transaction details fetched successfully.",
        ),
      );
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true)
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

async function getAllTransactions(req, res, next) {
  try {
    const {
      page = 1,
      limit = 10,
      transactionType,
      category,
      paymentMethod,
      search,
      sortBy = "date",
      sortOrder = "desc",
    } = req.query;

    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;

    const pipeline = [];

    // --- Main Filtering Stage ---
    const matchQuery = { isDeleted: { $ne: true } };
    if (transactionType) matchQuery.transactionType = transactionType;
    if (category) matchQuery.category = category;
    if (paymentMethod) matchQuery.paymentMethod = paymentMethod;
    if (search) matchQuery.description = { $regex: escapeRegex(search), $options: "i" };

    if (Object.keys(matchQuery).length > 0) {
      pipeline.push({ $match: matchQuery });
    }

    const sort = { [sortBy]: sortOrder === "asc" ? 1 : -1 };

    // --- Facet Stage for Parallel Execution ---
    pipeline.push({
      $facet: {
        // Facet 1: Main data with pagination and lookups
        data: [
          { $sort: sort },
          { $skip: skip },
          { $limit: limitNum },
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
        ],
        // Facet 2: Metadata for total count
        metadata: [{ $count: "total" }],
        // Facet 3: Distinct categories
        categories: [
          { $group: { _id: "$category" } },
          { $project: { _id: 0, category: "$_id" } },
        ],
      },
    });

    const result = await Transaction.aggregate(pipeline);

    const transactions = result[0].data;
    const totalCount = result[0].metadata[0] ? result[0].metadata[0].total : 0;
    const categories = result[0].categories.map((c) => c.category);

    const response = {
      transactions: {
        docs: transactions,
        totalDocs: totalCount,
        limit: limitNum,
        totalPages: Math.ceil(totalCount / limitNum),
        page: pageNum,
        // You can add other pagination fields if needed
      },
      categories,
    };

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          response,
          "All transactions fetched successfully.",
        ),
      );
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true)
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

async function getTransactionStats(req, res, next) {
  try {
    const {
      startDate,
      endDate,
      transactionType,
      category,
      paymentMethod,
      accountId,
    } = req.query;

    const matchQuery = { isDeleted: { $ne: true } };

    if (startDate || endDate) {
      matchQuery.date = {};
      if (startDate)
        matchQuery.date.$gte = startOfDay(
          new Date(startDate),
          req.businessTimezone,
        );
      if (endDate)
        matchQuery.date.$lte = endOfDay(
          new Date(endDate),
          req.businessTimezone,
        );
    }
    if (transactionType) matchQuery.transactionType = transactionType;
    if (category) matchQuery.category = category;
    if (paymentMethod) matchQuery.paymentMethod = paymentMethod;
    if (accountId) matchQuery.accountId = accountId;

    const stats = await Transaction.aggregate([
      { $match: matchQuery },
      {
        $facet: {
          overallStats: [
            {
              $group: {
                _id: null,
                totalTransactionsCount: { $sum: 1 },
                totalAmount: { $sum: "$amount" },
                averageTransactionAmount: { $avg: "$amount" },
                maxTransactionAmount: { $max: "$amount" },
                minTransactionAmount: { $min: "$amount" },
              },
            },
            {
              $project: {
                _id: 0,
                totalTransactionsCount: 1,
                totalAmount: 1,
                averageTransactionAmount: 1,
                maxTransactionAmount: 1,
                minTransactionAmount: 1,
              },
            },
          ],
          paymentMethodStats: [
            {
              $group: {
                _id: "$paymentMethod",
                count: { $sum: 1 },
                totalAmount: { $sum: "$amount" },
              },
            },
            {
              $project: {
                _id: 0, // Exclude _id
                paymentMethod: "$_id",
                count: 1,
                totalAmount: 1,
              },
            },
          ],
        },
      },
      {
        $project: {
          overall: { $arrayElemAt: ["$overallStats", 0] },
          paymentMethods: "$paymentMethodStats",
        },
      },
    ]);

    // Format the paymentMethodStats into the desired output
    const formattedStats = {
      totalTransactionsCount: stats[0]?.overall?.totalTransactionsCount || 0,
      totalAmount: stats[0]?.overall?.totalAmount || 0,
      averageTransactionAmount:
        stats[0]?.overall?.averageTransactionAmount || 0,
      maxTransactionAmount: stats[0]?.overall?.maxTransactionAmount || 0,
      minTransactionAmount: stats[0]?.overall?.minTransactionAmount || 0,
      totalBankTransactionCount: 0,
      totalMobileBankingTransactionCount: 0,
      totalCashTransactionCount: 0,
      totalBankTransactionsAmount: 0,
      totalMobileBankingTransactionsAmount: 0,
      totalCashTransactionsAmount: 0,
    };

    stats[0]?.paymentMethods?.forEach((pmStat) => {
      if (pmStat.paymentMethod === "Bank") {
        formattedStats.totalBankTransactionCount = pmStat.count;
        formattedStats.totalBankTransactionsAmount = pmStat.totalAmount;
      } else if (pmStat.paymentMethod === "Mobile Banking") {
        formattedStats.totalMobileBankingTransactionCount = pmStat.count;
        formattedStats.totalMobileBankingTransactionsAmount =
          pmStat.totalAmount;
      } else if (pmStat.paymentMethod === "Cash") {
        formattedStats.totalCashTransactionCount = pmStat.count;
        formattedStats.totalCashTransactionsAmount = pmStat.totalAmount;
      }
    });

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          formattedStats,
          "Transaction statistics fetched successfully.",
        ),
      );
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true)
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

async function getTransactionsByAccount(req, res, next) {
  try {
    const { accountId } = req.params;
    const {
      page = 1,
      limit = 10,
      sortBy = "date",
      sortOrder = "desc",
      category,
      transactionType,
      paymentMethod,
      search,
    } = req.query;

    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;

    const pipeline = [];

    // --- Main Filtering Stage ---
    const matchQuery = {
      accountId: new mongoose.Types.ObjectId(accountId),
      isDeleted: { $ne: true },
    };
    if (category) matchQuery.category = category;
    if (transactionType) matchQuery.transactionType = transactionType;
    if (paymentMethod) matchQuery.paymentMethod = paymentMethod;
    if (search) matchQuery.description = { $regex: escapeRegex(search), $options: "i" };

    pipeline.push({ $match: matchQuery });

    const sort = { [sortBy]: sortOrder === "asc" ? 1 : -1 };

    // --- Facet Stage for Parallel Execution ---
    pipeline.push({
      $facet: {
        // Facet 1: Main data with pagination and lookups
        data: [
          { $sort: sort },
          { $skip: skip },
          { $limit: limitNum },
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
        ],
        // Facet 2: Metadata for total count
        metadata: [{ $count: "total" }],
        // Facet 3: Distinct categories for this account's transactions
        categories: [
          { $group: { _id: "$category" } },
          { $project: { _id: 0, category: "$_id" } },
        ],
      },
    });

    const result = await Transaction.aggregate(pipeline);

    const transactions = result[0].data;
    const totalCount = result[0].metadata[0] ? result[0].metadata[0].total : 0;
    const categories = result[0].categories.map((c) => c.category);

    const response = {
      transactions: {
        docs: transactions,
        totalDocs: totalCount,
        limit: limitNum,
        totalPages: Math.ceil(totalCount / limitNum),
        page: pageNum,
      },
      categories,
    };

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          response,
          "Transactions for the account fetched successfully.",
        ),
      );
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
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

async function deleteTransaction(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const { user } = req;

    const transaction = await Transaction.findById(id).session(session);

    if (!transaction) {
      throw new ApiError(404, "Transaction not found");
    }
    if (transaction.isDeleted) {
      throw new ApiError(400, "Transaction is already in the trash");
    }
    if (transaction.source === "Auto") {
      throw new ApiError(
        400,
        "Cannot delete an automatically generated transaction. Please delete the source (e.g., Sale, LC) instead.",
      );
    }

    // DailyCash Gatekeeper Check
    const transactionDate = startOfDay(new Date(transaction.date), req.businessTimezone);
    const dailyCash = await DailyCash.findOne({
      date: transactionDate,
      status: "Open",
    }).session(session);
    if (!dailyCash) {
      throw new ApiError(
        400,
        `Daily cash is closed for ${transactionDate.toDateString()}. Cannot delete transaction.`,
      );
    }

    const account = await Account.findById(transaction.accountId).session(
      session,
    );
    if (!account) {
      throw new ApiError(404, "Associated account not found");
    }

    // Reverse the balance adjustment
    if (transaction.transactionType === "Income") {
      if (account.balance < transaction.amount) {
        throw new ApiError(
          400,
          `Insufficient balance in ${account.accountName} to reverse this income transaction.`,
        );
      }
      // account.balance -= transaction.amount;
      account.balance = mathUtil.sub(account.balance, transaction.amount);
    } else if (transaction.transactionType === "Expense") {
      // account.balance += transaction.amount;
      account.balance = mathUtil.add(account.balance, transaction.amount);
    }

    await account.save({ session });

    // Mark the transaction as deleted
    transaction.isDeleted = true;
    transaction.deletedBy = user?._id || null;
    await transaction.save({ session });

    // Move to trash
    await Trash.create({
      docId: transaction._id,
      model: "Transaction",
      deletedBy: user?._id || null,
      deletedAt: now(),
    });
    await session.commitTransaction();
    session.endSession();

    // Audit: Transaction deleted
    auditService.log({ action: "DELETE", module: "Transaction", documentId: transaction._id, userId: user?._id, description: `Deleted transaction ${transaction.name} (${transaction.transactionType}: ${transaction.amount})`, req });

    return res
      .status(200)
      .json(
        new ApiResponse(200, null, "Transaction moved to trash successfully"),
      );
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    if (error instanceof ApiError) {
      return next(error);
    }
    logger.error("DeleteTransaction Error:", error);
    next(
      new ApiError(
        500,
        "Failed to move transaction to trash. Please try again.",
      ),
    );
  }
}

module.exports = {
  createTransaction,
  updateTransaction,
  getAllTransactions,
  getTransactionDetails,
  getTransactionStats,
  getTransactionsByAccount,
  deleteTransaction,
};

async function transferMoney(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { fromAccountId, toAccountId, amount, date, description, reference } =
      req.body;

    if (!fromAccountId || !toAccountId || !amount || !date) {
      throw new ApiError(
        400,
        "Source, destination, amount, and date are required.",
      );
    }

    if (fromAccountId === toAccountId) {
      throw new ApiError(400, "Cannot transfer money to the same account.");
    }

    if (amount <= 0) {
      throw new ApiError(400, "Transfer amount must be greater than zero.");
    }

    // DailyCash Gatekeeper Check
    // We use the provided date to check if the day is open.
    // However, for the transaction record itself, we trust the 'date' passed in (which might have specific time).
    const transactionDate = startOfDay(new Date(date), req.businessTimezone);
    const dailyCash = await DailyCash.findOne({
      date: transactionDate,
      status: "Open",
    }).session(session);

    if (!dailyCash) {
      throw new ApiError(
        400,
        `Daily cash is closed for ${transactionDate.toDateString()}. Cannot transfer money.`,
      );
    }

    // 1. Handle Source Account (Expense)
    const sourceAccount = await Account.findById(fromAccountId).session(
      session,
    );
    if (!sourceAccount) {
      throw new ApiError(404, "Source account not found.");
    }

    if (sourceAccount.balance < amount) {
      throw new ApiError(
        400,
        `Insufficient balance in ${sourceAccount.accountName}.`,
      );
    }

    // sourceAccount.balance -= amount;
    sourceAccount.balance = mathUtil.sub(sourceAccount.balance, amount);
    await sourceAccount.save({ session });

    // 2. Handle Destination Account (Income)
    const destAccount = await Account.findById(toAccountId).session(session);
    if (!destAccount) {
      throw new ApiError(404, "Destination account not found.");
    }

    // destAccount.balance += amount;
    destAccount.balance = mathUtil.add(destAccount.balance, amount);
    await destAccount.save({ session });

    // Format Description
    // If user provided a description, append it to the context.
    const sourceDescription = description
      ? `Transfer to ${formatAccountLabel(destAccount)} - ${description}`
      : `Transfer to ${formatAccountLabel(destAccount)}`;

    const destDescription = description
      ? `Transfer from ${formatAccountLabel(sourceAccount)} - ${description}`
      : `Transfer from ${formatAccountLabel(sourceAccount)}`;

    // 3. Create Expense Transaction for Source
    const expenseTrx = await Transaction.create(
      [
        {
          accountId: fromAccountId,
          date, // Uses the full timestamp if provided
          transactionType: "Expense",
          amount,
          name: `Transfer to ${destAccount.accountName}`,
          source: "Manual",
          paymentMethod: sourceAccount.accountType,
          description: sourceDescription,
          category: "Transfer Out",
          isDeleted: false,
          createdBy: req.user?._id || null,
          miscReference: { transferTo: toAccountId, referenceNote: reference },
        },
      ],
      { session },
    );

    // 4. Create Income Transaction for Destination
    const incomeTrx = await Transaction.create(
      [
        {
          accountId: toAccountId,
          date, // Uses the full timestamp if provided
          transactionType: "Income",
          amount,
          name: `Transfer from ${sourceAccount.accountName}`,
          source: "Manual",
          paymentMethod: destAccount.accountType,
          description: destDescription,
          category: "Transfer In",
          isDeleted: false,
          createdBy: req.user?._id || null,
          miscReference: {
            transferFrom: fromAccountId,
            referenceNote: reference,
            relatedTransactionId: expenseTrx[0]._id,
          },
        },
      ],
      { session },
    );

    // Link expense to income
    expenseTrx[0].miscReference.relatedTransactionId = incomeTrx[0]._id;
    await expenseTrx[0].save({ session });

    await session.commitTransaction();
    session.endSession();

    // Audit: Transfer
    auditService.log({ action: "TRANSFER", module: "Transaction", documentId: expenseTrx[0]._id, userId: req.user?._id, description: `Transferred ${amount} from ${sourceAccount.accountName} to ${destAccount.accountName}`, metadata: { fromAccountId, toAccountId, amount }, req });

    return res.status(200).json(
      new ApiResponse(
        200,
        {
          sourceTransaction: expenseTrx[0],
          destTransaction: incomeTrx[0],
        },
        "Money transferred successfully.",
      ),
    );
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    if (error instanceof ApiError) {
      return next(error);
    }
    logger.error("TransferMoney Error:", error);
    next(new ApiError(500, "Failed to transfer money. Please try again."));
  }
}

module.exports = {
  createTransaction,
  updateTransaction,
  getAllTransactions,
  getTransactionDetails,
  getTransactionStats,
  getTransactionsByAccount,
  deleteTransaction,
  transferMoney,
};
