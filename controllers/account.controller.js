const Account = require("../models/account.model");
const Transaction = require("../models/transaction.model");
const DailyCash = require("../models/dailyCash.model"); // Added
const { ApiError } = require("../utils/ApiError");
const logger = require("../utils/logger");
const { ApiResponse } = require("../utils/ApiResponse");
const { formatAccountLabel } = require("../utils/format.util");
const mongoose = require("mongoose"); // Added
const {
  startOfDay,
  endOfDay,
  now,
  formatInTimeZone,
} = require("../utils/timezone.util");
const auditService = require("../services/audit.service");

async function createAccount(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    // Strict validation for payload keys
    const allowedFields = new Set([
      "accountType",
      "accountName",
      "initialBalance",
      "accountHolderName",
      "bankName",
      "branchName",
      "accountNumber",
      "swiftCode",
      "serviceName",
      "mobileNumber",
      "routingNumber",
    ]);

    const validationErrors = [];
    const bodyKeys = Object.keys(req.body);

    for (const key of bodyKeys) {
      if (!allowedFields.has(key)) {
        validationErrors.push({
          field: key,
          message: `Field '${key}' is not allowed.`,
        });
      }
    }

    if (validationErrors.length > 0) {
      throw new ApiError(400, validationErrors[0].message, validationErrors);
    }

    const {
      accountType,
      accountName,
      initialBalance, // Changed from balance to initialBalance
      accountHolderName,
      bankName,
      branchName,
      accountNumber,
      swiftCode,
      serviceName,
      mobileNumber,
      routingNumber,
    } = req.body;

    const validAccountTypes = ["Bank", "Mobile Banking", "Cash"];
    if (!validAccountTypes.includes(accountType)) {
      throw new ApiError(
        400,
        `'${accountType}' is not a valid value for 'accountType'. Allowed values are: ${validAccountTypes.join(
          ", ",
        )}.`,
      );
    }

    // Business logic validation for initialBalance
    if (initialBalance < 0) {
      validationErrors.push({
        field: "initialBalance",
        message: "Initial balance cannot be negative",
      });
    }

    if (validationErrors.length > 0) {
      throw new ApiError(400, validationErrors[0].message, validationErrors);
    }

    // Filter fields based on accountType to prevent irrelevant data storage
    let accountData;

    if (accountType === "Cash") {
      accountData = {
        accountType,
        accountName,
        balance: initialBalance || 0,
        accountHolderName,
      };
    } else if (accountType === "Bank") {
      accountData = {
        accountType,
        accountName,
        balance: initialBalance || 0,
        accountHolderName,
        bankName,
        branchName,
        accountNumber,
        swiftCode,
        routingNumber,
      };
    } else if (accountType === "Mobile Banking") {
      accountData = {
        accountType,
        accountName,
        balance: initialBalance || 0,
        accountHolderName,
        serviceName,
        mobileNumber,
      };
    }

    // Add createdBy field
    accountData.createdBy = req.user?._id || null;

    // Check for existing archived accounts with similar details
    let existingArchivedAccountQuery = { status: "Archived" };
    if (accountType === "Cash") {
      existingArchivedAccountQuery.accountName = accountName;
      existingArchivedAccountQuery.accountHolderName = accountHolderName;
    } else if (accountType === "Bank") {
      existingArchivedAccountQuery.bankName = bankName;
      existingArchivedAccountQuery.accountNumber = accountNumber;
    } else if (accountType === "Mobile Banking") {
      existingArchivedAccountQuery.serviceName = serviceName;
      existingArchivedAccountQuery.mobileNumber = mobileNumber;
    }

    const existingArchivedAccount = await Account.findOne(
      existingArchivedAccountQuery,
    ).session(session);

    if (existingArchivedAccount) {
      throw new ApiError(
        400,
        `An archived account with similar details already exists for ${accountType} type.`,
      );
    }

    const account = await Account.create([accountData], { session });

    const createdAccount = account[0]; // Mongoose create with session returns an array

    // If there's an initial balance, create a corresponding transaction
    if (initialBalance && initialBalance > 0) {
      // 1. DailyCash Gatekeeper Check (use request timezone)
      const timezone = req.businessTimezone; // Get timezone from middleware
      const currentTime = now();
      const startOfToday = startOfDay(currentTime, timezone);
      const endOfToday = endOfDay(currentTime, timezone);

      const dailyCash = await DailyCash.findOne({
        date: {
          $gte: startOfToday,
          $lt: endOfToday,
        },
      })
        .sort({ createdAt: -1 })
        .session(session);

      if (!dailyCash || dailyCash.status === "Closed") {
        const todayString = formatInTimeZone(currentTime, "PPP", timezone);
        throw new ApiError(
          400,
          `Daily cash is closed for ${todayString}. Cannot create account with initial balance. Open daily cash first.`,
        );
      }

      // 2. Create Transaction for initial balance
      await Transaction.create(
        [
          {
            accountId: createdAccount._id,
            date: now(),
            transactionType: "Income",
            amount: initialBalance,
            name: "Initial Balance",
            source: "Account",
            paymentMethod: createdAccount.accountType, // Use the account's type as payment method
            description: `Initial balance for new ${accountType} Account: ${formatAccountLabel(createdAccount)}.`,
            category: "Initial Balance",
            miscReference: {
              accountId: createdAccount._id,
              accountName: createdAccount.accountName,
              accountType: createdAccount.accountType,
            },
            createdBy: req.user?._id || null, // Add audit trail field
          },
        ],
        { session },
      );
    }

    await session.commitTransaction();
    session.endSession();

    // Audit: Account created
    auditService.log({ action: "CREATE", module: "Account", documentId: createdAccount._id, userId: req.user?._id, description: `Created ${accountType} account: ${createdAccount.accountName}`, req });

    return res
      .status(201)
      .json(
        new ApiResponse(201, createdAccount, "Account created successfully"),
      );
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle duplicate account errors from model's pre-save hook
    if (error.name === "DuplicateAccountError") {
      return next(new ApiError(409, error.message)); // 409 Conflict
    }
    // Handle Mongoose validation errors
    if (error.name === "ValidationError") {
      // Prioritize accountType enum error
      if (
        error.errors.accountType &&
        error.errors.accountType.kind === "enum"
      ) {
        const errorDetail = error.errors.accountType;
        const userFriendlyMessage = `'${errorDetail.value}' is not a valid value for 'accountType'. Allowed values are: ${errorDetail.properties.enumValues.join(", ")}.`;
        return next(new ApiError(400, userFriendlyMessage, error.errors));
      }

      // Fallback for other validation errors
      const firstErrorField = Object.keys(error.errors)[0];
      let userFriendlyMessage = "Validation failed.";

      if (firstErrorField) {
        const errorDetail = error.errors[firstErrorField];
        if (errorDetail.kind === "enum") {
          userFriendlyMessage = `'${errorDetail.value}' is not a valid value for the field '${firstErrorField}'. Allowed values are: ${errorDetail.properties.enumValues.join(", ")}.`;
        } else if (errorDetail.kind === "required") {
          userFriendlyMessage = `The field '${firstErrorField}' is required.`;
        } else {
          userFriendlyMessage = errorDetail.message;
        }
      }
      return next(new ApiError(400, userFriendlyMessage, error.errors));
    }
    logger.error("Account creation failed:", {
      message: error.message,
      stack: error.stack,
      name: error.name,
    });
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

async function getAllAccounts(req, res, next) {
  try {
    const accounts = await Account.find({ status: "Active" }).lean();
    return res
      .status(200)
      .json(
        new ApiResponse(200, accounts, "Active accounts fetched successfully"),
      );
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    logger.error("Get all accounts failed:", {
      message: error.message,
      stack: error.stack,
    });
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

async function getAccountById(req, res, next) {
  try {
    const { id } = req.params;
    const account = await Account.findById(id).lean();

    if (!account) {
      return next(new ApiError(404, "Account not found"));
    }

    if (account.status === "Archived") {
      return res
        .status(200)
        .json(
          new ApiResponse(
            200,
            account,
            "Archived account fetched successfully",
          ),
        );
    }

    return res
      .status(200)
      .json(new ApiResponse(200, account, "Account fetched successfully"));
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    logger.error("Get account by ID failed:", {
      message: error.message,
      stack: error.stack,
    });
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

async function updateAccount(req, res, next) {
  try {
    const { id } = req.params;

    // Allowlist: only these fields can be updated by the client
    const ALLOWED_UPDATE_FIELDS = [
      "accountName", "accountHolderName", "bankName", "branchName",
      "accountNumber", "swiftCode", "routingNumber", "serviceName",
      "mobileNumber", "status",
    ];

    const updateData = {};
    for (const key of ALLOWED_UPDATE_FIELDS) {
      if (req.body[key] !== undefined) updateData[key] = req.body[key];
    }

    const existingAccount = await Account.findById(id);

    if (!existingAccount) {
      return next(new ApiError(404, "Account not found"));
    }

    // If the account is archived, prevent updates unless it's a reactivation
    if (existingAccount.status === "Archived") {
      if (updateData.status === "Active") {
        // Allow reactivation, but remove other updateData to prevent unexpected changes
        const updatedAccount = await Account.findByIdAndUpdate(
          id,
          { status: "Active" }, // Only update status for reactivation
          { new: true, runValidators: true },
        );
        return res
          .status(200)
          .json(
            new ApiResponse(
              200,
              updatedAccount,
              "Account reactivated successfully",
            ),
          );
      } else {
        throw new ApiError(
          400,
          "Cannot update an archived account. Reactivate it first if you wish to modify its details.",
        );
      }
    }

    // Check for actual changes before updating
    let hasChanges = false;
    for (const key in updateData) {
      if (Object.prototype.hasOwnProperty.call(updateData, key)) {
        // Compare values, ensuring proper handling of different types if necessary.
        // Mongoose document properties can be accessed directly.
        if (existingAccount[key] !== updateData[key]) {
          hasChanges = true;
          break;
        }
      }
    }

    if (!hasChanges) {
      return res
        .status(200)
        .json(new ApiResponse(200, existingAccount, "No changes made"));
    }

    const updatedAccount = await Account.findByIdAndUpdate(
      id,
      { ...updateData, modifiedBy: req.user?._id || null },
      {
        new: true,
        runValidators: true,
      },
    );

    if (!updatedAccount) {
      return next(new ApiError(404, "Account not found"));
    }

    // Audit: Account updated
    auditService.log({ action: "UPDATE", module: "Account", documentId: id, userId: req.user?._id, description: `Updated account: ${updatedAccount.accountName}`, changes: auditService.diffChanges(existingAccount, updatedAccount, ["accountName", "accountHolderName", "bankName", "branchName", "accountNumber", "mobileNumber"]), req });

    return res
      .status(200)
      .json(
        new ApiResponse(200, updatedAccount, "Account updated successfully"),
      );
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    logger.error("Update account failed:", {
      message: error.message,
      stack: error.stack,
    });
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

async function deleteAccount(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;

    const account = await Account.findById(id).session(session);

    if (!account) {
      throw new ApiError(404, "Account not found");
    }

    if (account.balance !== 0) {
      throw new ApiError(
        400,
        "Cannot archive account with a non-zero balance.",
      );
    }

    const lcWithAccount = await mongoose
      .model("LC")
      .findOne({
        $or: [
          { "basicInfo.accountId": id },
          { "financialInfo.costs.accountId": id },
          { "shippingCustomsInfo.costs.accountId": id },
          { "agentTransportInfo.costs.accountId": id },
          { "otherExpenses.costs.accountId": id },
          { "documentProductInfo.costs.accountId": id },
        ],
      })
      .session(session);

    if (lcWithAccount) {
      throw new ApiError(
        400,
        "Cannot archive account. It is associated with an LC.",
      );
    }

    const saleWithAccount = await mongoose
      .model("Sales")
      .findOne({
        $or: [{ "costs.accountId": id }, { "payments.accountId": id }],
      })
      .session(session);

    if (saleWithAccount) {
      throw new ApiError(
        400,
        "Cannot archive account. It is associated with a sale.",
      );
    }

    const transactionCount = await Transaction.countDocuments({
      accountId: id,
    }).session(session);

    let updateData = {
      status: "Archived",
      deletedBy: req.user?._id || null,
    };

    // If transactions exist, we DO NOT soft delete (isDeleted: true),
    // we only archive it to preserve history and referential integrity for Mongoose queries.
    if (transactionCount === 0) {
      updateData.isDeleted = true;
    }

    const archivedAccount = await Account.findByIdAndUpdate(
      id,
      updateData,
      { new: true, session },
    );

    if (!archivedAccount) {
      // This case should ideally not be reached if the above findById worked, but it's a safeguard.
      throw new ApiError(404, "Account not found for archiving.");
    }

    await session.commitTransaction();
    session.endSession();

    // Audit: Account archived/deleted
    auditService.log({ action: "DELETE", module: "Account", documentId: archivedAccount._id, userId: req.user?._id, description: `Archived account: ${archivedAccount.accountName} (${archivedAccount.accountType})`, req });

    return res
      .status(200)
      .json(
        new ApiResponse(200, archivedAccount, "Account archived successfully"),
      );
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    if (error instanceof ApiError) {
      return next(error);
    }
    logger.error("Delete account failed:", {
      message: error.message,
      stack: error.stack,
    });
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

async function getAccountDetails(req, res, next) {
  try {
    const { id } = req.params;

    const results = await Account.aggregate([
      {
        $match: {
          _id: new mongoose.Types.ObjectId(id),
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
      // Optimized: compute transaction stats inside the $lookup sub-pipeline
      // This avoids $unwind-ing all transactions into the parent document
      {
        $lookup: {
          from: "transactions",
          let: { accountId: "$_id" },
          pipeline: [
            { $match: { $expr: { $eq: ["$accountId", "$$accountId"] } } },
            {
              $group: {
                _id: null,
                totalIncome: {
                  $sum: { $cond: [{ $eq: ["$transactionType", "Income"] }, "$amount", 0] },
                },
                totalExpense: {
                  $sum: { $cond: [{ $eq: ["$transactionType", "Expense"] }, "$amount", 0] },
                },
                largestIncome: {
                  $max: { $cond: [{ $eq: ["$transactionType", "Income"] }, "$amount", 0] },
                },
                largestExpense: {
                  $max: { $cond: [{ $eq: ["$transactionType", "Expense"] }, "$amount", 0] },
                },
                totalTransactionsCount: { $sum: 1 },
                totalIncomingTransactionsCount: {
                  $sum: { $cond: [{ $eq: ["$transactionType", "Income"] }, 1, 0] },
                },
                totalOutgoingTransactionsCount: {
                  $sum: { $cond: [{ $eq: ["$transactionType", "Expense"] }, 1, 0] },
                },
                totalTransactionAmount: { $sum: "$amount" },
              },
            },
          ],
          as: "txStats",
        },
      },
      {
        $addFields: {
          txStats: { $arrayElemAt: ["$txStats", 0] },
        },
      },
      {
        $project: {
          account: {
            _id: "$_id",
            accountType: "$accountType",
            accountName: "$accountName",
            balance: "$balance",
            accountHolderName: "$accountHolderName",
            bankName: "$bankName",
            branchName: "$branchName",
            accountNumber: "$accountNumber",
            swiftCode: "$swiftCode",
            serviceName: "$serviceName",
            mobileNumber: "$mobileNumber",
            routingNumber: "$routingNumber",
            status: "$status",
            createdAt: "$createdAt",
            updatedAt: "$updatedAt",
            createdBy: {
              name: "$createdBy.name",
              email: "$createdBy.email",
            },
            modifiedBy: {
              name: "$modifiedBy.name",
              email: "$modifiedBy.email",
            },
            deletedBy: {
              name: "$deletedBy.name",
              email: "$deletedBy.email",
            },
          },
          stats: {
            currentBalance: "$balance",
            totalIncome: { $ifNull: ["$txStats.totalIncome", 0] },
            totalExpense: { $ifNull: ["$txStats.totalExpense", 0] },
            largestIncome: { $ifNull: ["$txStats.largestIncome", 0] },
            largestExpense: { $ifNull: ["$txStats.largestExpense", 0] },
            averageTransactionAmount: {
              $cond: [
                { $eq: [{ $ifNull: ["$txStats.totalTransactionsCount", 0] }, 0] },
                0,
                {
                  $divide: [
                    "$txStats.totalTransactionAmount",
                    "$txStats.totalTransactionsCount",
                  ],
                },
              ],
            },
            totalTransactionsCount: { $ifNull: ["$txStats.totalTransactionsCount", 0] },
            totalIncomingTransactionsCount: { $ifNull: ["$txStats.totalIncomingTransactionsCount", 0] },
            totalOutgoingTransactionsCount: { $ifNull: ["$txStats.totalOutgoingTransactionsCount", 0] },
          },
          _id: 0,
        },
      },
    ]);

    if (!results.length) {
      return next(new ApiError(404, "Account not found"));
    }

    // If there were no transactions, the aggregation will still return the account
    // with empty stats, which is the desired behavior.
    const accountDetails = results[0];

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          accountDetails,
          "Account details fetched successfully",
        ),
      );
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    logger.error("Get account details failed:", {
      message: error.message,
      stack: error.stack,
    });
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

module.exports = {
  createAccount,
  getAllAccounts,
  getAccountById,
  updateAccount,
  deleteAccount,
  getAccountDetails,
};

/* ================= SEARCH (lightweight, for combobox autocomplete) ================= */
async function searchAccounts(req, res, next) {
  try {
    const { q = "", accountType, limit = 20 } = req.query;
    const query = { status: "Active" };

    if (accountType) {
      query.accountType = accountType;
    }

    if (q.trim()) {
      const searchRegex = { $regex: q.trim(), $options: "i" };
      query.$or = [
        { accountName: searchRegex },
        { accountHolderName: searchRegex },
        { bankName: searchRegex },
        { branchName: searchRegex },
        { accountNumber: searchRegex },
        { serviceName: searchRegex },
      ];
    }

    const accounts = await Account.find(query)
      .select("accountType accountName accountHolderName bankName branchName accountNumber serviceName mobileNumber balance")
      .sort({ accountName: 1 })
      .limit(parseInt(limit, 10))
      .lean();

    return res
      .status(200)
      .json(new ApiResponse(200, accounts, "Accounts searched successfully"));
  } catch (error) {
    logger.error(error);
    next(new ApiError(500, "Failed to search accounts."));
  }
}

module.exports.searchAccounts = searchAccounts;
