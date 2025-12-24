const Account = require("../models/account.model");
const Transaction = require("../models/transaction.model");
const DailyCash = require("../models/dailyCash.model"); // Added
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const mongoose = require("mongoose"); // Added

async function createAccount(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    // Strict validation for payload keys
    const allowedFields = new Set([
      "accountType", "accountName", "initialBalance", "accountHolderName",
      "bankName", "branchName", "accountNumber", "swiftCode",
      "serviceName", "mobileNumber", "routingNumber"
    ]);

    const validationErrors = [];
    const bodyKeys = Object.keys(req.body);

    for (const key of bodyKeys) {
      if (!allowedFields.has(key)) {
        validationErrors.push({ field: key, message: `Field '${key}' is not allowed.` });
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
        throw new ApiError(400, `'${accountType}' is not a valid value for 'accountType'. Allowed values are: ${validAccountTypes.join(', ')}.`);
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

    const existingArchivedAccount = await Account.findOne(existingArchivedAccountQuery).session(session);

    if (existingArchivedAccount) {
      throw new ApiError(400, `An archived account with similar details already exists for ${accountType} type.`);
    }

    const account = await Account.create(
      [
        accountData
      ],
      { session }
    );

    const createdAccount = account[0]; // Mongoose create with session returns an array

    // If there's an initial balance, create a corresponding transaction
    if (initialBalance && initialBalance > 0) {
      // 1. DailyCash Gatekeeper Check
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const dailyCash = await DailyCash.findOne({ date: today })
        .sort({ createdAt: -1 })
        .session(session);

      if (!dailyCash || dailyCash.status === "Closed") {
        throw new ApiError(
          400,
          `Daily cash is closed for ${today.toDateString()}. Cannot create account with initial balance. Open daily cash first.`
        );
      }

      // 2. Create Transaction for initial balance
      await Transaction.create(
        [
          {
            accountId: createdAccount._id,
            date: new Date(),
            transactionType: "Income",
            amount: initialBalance,
            name: "Initial Balance",
            source: "Account",
            paymentMethod: createdAccount.accountType, // Use the account's type as payment method
            description: `Initial balance for new ${createdAccount.accountType} account '${createdAccount.accountName}'`,
            category: "Initial Balance",
            miscReference: {
              accountId: createdAccount._id,
              accountName: createdAccount.accountName,
              accountType: createdAccount.accountType,
            },
          },
        ],
        { session }
      );
    }

    await session.commitTransaction();
    session.endSession();

    return res
      .status(201)
      .json(
        new ApiResponse(201, createdAccount, "Account created successfully")
      );
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle duplicate account errors from model's pre-save hook
    if (error.name === 'DuplicateAccountError') {
      return next(new ApiError(409, error.message)); // 409 Conflict
    }
    // Handle Mongoose validation errors
    if (error.name === 'ValidationError') {
      // Prioritize accountType enum error
      if (error.errors.accountType && error.errors.accountType.kind === 'enum') {
        const errorDetail = error.errors.accountType;
        const userFriendlyMessage = `'${errorDetail.value}' is not a valid value for 'accountType'. Allowed values are: ${errorDetail.properties.enumValues.join(', ')}.`;
        return next(new ApiError(400, userFriendlyMessage, error.errors));
      }

      // Fallback for other validation errors
      const firstErrorField = Object.keys(error.errors)[0];
      let userFriendlyMessage = "Validation failed.";

      if (firstErrorField) {
        const errorDetail = error.errors[firstErrorField];
        if (errorDetail.kind === 'enum') {
          userFriendlyMessage = `'${errorDetail.value}' is not a valid value for the field '${firstErrorField}'. Allowed values are: ${errorDetail.properties.enumValues.join(', ')}.`;
        } else if (errorDetail.kind === 'required') {
          userFriendlyMessage = `The field '${firstErrorField}' is required.`;
        } else {
          userFriendlyMessage = errorDetail.message;
        }
      }
      return next(new ApiError(400, userFriendlyMessage, error.errors));
    }
    next(new ApiError(500, error.message || "Something went wrong"));
  }
}

async function getAllAccounts(req, res, next) {
  try {
    const accounts = await Account.find({ status: "Active" });
    return res
      .status(200)
      .json(new ApiResponse(200, accounts, "Active accounts fetched successfully"));
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    next(new ApiError(500, error.message || "Something went wrong"));
  }
}


async function getAccountById(req, res, next) {
  try {
    const { id } = req.params;
    const account = await Account.findById(id);

    if (!account) {
      return next(new ApiError(404, "Account not found"));
    }

    if (account.status === "Archived") {
      return res
        .status(200)
        .json(new ApiResponse(200, account, "Archived account fetched successfully"));
    }

    return res
      .status(200)
      .json(new ApiResponse(200, account, "Account fetched successfully"));
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    next(new ApiError(500, error.message || "Something went wrong"));
  }
}

async function updateAccount(req, res, next) {
  try {
    const { id } = req.params;
    const updateData = req.body;

    const existingAccount = await Account.findById(id);

    if (!existingAccount) {
      return next(new ApiError(404, "Account not found"));
    }

    // Prevent direct update of the balance
    if (updateData.balance) {
      delete updateData.balance;
    }

    // If the account is archived, prevent updates unless it's a reactivation
    if (existingAccount.status === "Archived") {
      if (updateData.status === "Active") {
        // Allow reactivation, but remove other updateData to prevent unexpected changes
        const updatedAccount = await Account.findByIdAndUpdate(
          id,
          { status: "Active" }, // Only update status for reactivation
          { new: true, runValidators: true }
        );
        return res
          .status(200)
          .json(new ApiResponse(200, updatedAccount, "Account reactivated successfully"));
      } else {
        throw new ApiError(400, "Cannot update an archived account. Reactivate it first if you wish to modify its details.");
      }
    }

    const updatedAccount = await Account.findByIdAndUpdate(id, updateData, {
      new: true,
      runValidators: true,
    });

    if (!updatedAccount) {
      return next(new ApiError(404, "Account not found"));
    }

    return res
      .status(200)
      .json(new ApiResponse(200, updatedAccount, "Account updated successfully"));
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    next(new ApiError(500, error.message || "Something went wrong"));
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
      throw new ApiError(400, "Cannot archive account with a non-zero balance.");
    }

    const lcWithAccount = await mongoose.model('LC').findOne({
      $or: [
        { "basicInfo.accountId": id },
        { "financialInfo.costs.accountId": id },
        { "shippingCustomsInfo.costs.accountId": id },
        { "agentTransportInfo.costs.accountId": id },
        { "otherExpenses.costs.accountId": id }
      ]
    }).session(session);

    if (lcWithAccount) {
      throw new ApiError(400, "Cannot archive account. It is associated with an LC.");
    }

    const saleWithAccount = await mongoose.model('Sales').findOne({
      $or: [
        { "costs.accountId": id },
        { "payments.accountId": id }
      ]
    }).session(session);

    if (saleWithAccount) {
      throw new ApiError(400, "Cannot archive account. It is associated with a sale.");
    }

    const archivedAccount = await Account.findByIdAndUpdate(
      id,
      { status: "Archived" },
      { new: true, session }
    );

    if (!archivedAccount) {
      // This case should ideally not be reached if the above findById worked, but it's a safeguard.
      throw new ApiError(404, "Account not found for archiving.");
    }

    await session.commitTransaction();
    session.endSession();

    return res
      .status(200)
      .json(new ApiResponse(200, archivedAccount, "Account archived successfully"));
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    if (error instanceof ApiError) {
      return next(error);
    }
    next(new ApiError(500, error.message || "Something went wrong"));
  }
}

async function getAccountDetails(req, res, next) {
  try {
    const { id } = req.params;
    const account = await Account.findById(id);

    if (!account) {
      return next(new ApiError(404, "Account not found"));
    }

    const transactions = await Transaction.find({ accountId: id }).sort({
      date: -1,
    });

    let totalIncome = 0;
    let totalExpense = 0;
    let largestIncome = 0;
    let largestExpense = 0;
    let totalTransactionAmount = 0;
    let totalIncomingTransactionsCount = 0;
    let totalOutgoingTransactionsCount = 0;

    transactions.forEach((transaction) => {
      totalTransactionAmount += transaction.amount;
      if (transaction.transactionType === "Income") {
        totalIncome += transaction.amount;
        totalIncomingTransactionsCount++;
        if (transaction.amount > largestIncome) {
          largestIncome = transaction.amount;
        }
      } else if (transaction.transactionType === "Expense") {
        totalExpense += transaction.amount;
        totalOutgoingTransactionsCount++;
        if (transaction.amount > largestExpense) {
          largestExpense = transaction.amount;
        }
      }
    });

    const averageTransactionAmount =
      transactions.length > 0
        ? totalTransactionAmount / transactions.length
        : 0;

    const stats = {
      currentBalance: account.balance,
      totalIncome,
      totalExpense,
      largestIncome,
      largestExpense,
      averageTransactionAmount,
      totalTransactionsCount: transactions.length,
      totalIncomingTransactionsCount,
      totalOutgoingTransactionsCount,
    };

    const accountDetails = {
      account,
      stats,
    };

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          accountDetails,
          "Account details fetched successfully"
        )
      );
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    next(new ApiError(500, error.message || "Something went wrong"));
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
