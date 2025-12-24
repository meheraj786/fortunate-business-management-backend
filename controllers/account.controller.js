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

    const account = await Account.create(
      [
        {
          accountType,
          accountName,
          balance: initialBalance || 0,
          accountHolderName,
          bankName,
          branchName,
          accountNumber,
          swiftCode,
          serviceName,
          mobileNumber,
          routingNumber,
        },
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
      const firstErrorField = Object.keys(error.errors)[0]; // Get the first field with an error
      let userFriendlyMessage = "Validation failed."; // Default message

      if (firstErrorField) {
        userFriendlyMessage = `The field ${firstErrorField} is required.`;
      }
      // The 'errors' object in ApiError will now contain all validation errors
      return next(new ApiError(400, userFriendlyMessage, error.errors));
    }
    next(new ApiError(500, error.message || "Something went wrong"));
  }
}

async function getAllAccounts(req, res, next) {
  try {
    const accounts = await Account.find();
    return res
      .status(200)
      .json(new ApiResponse(200, accounts, "Accounts fetched successfully"));
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

    // Prevent direct update of the balance
    if (updateData.balance) {
      delete updateData.balance;
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
  try {
    const { id } = req.params;
    const deletedAccount = await Account.findByIdAndDelete(id);

    if (!deletedAccount) {
      return next(new ApiError(404, "Account not found"));
    }

    // Also delete all transactions associated with this account
    await Transaction.deleteMany({ account: id });

    return res
      .status(200)
      .json(new ApiResponse(200, deletedAccount, "Account deleted successfully"));
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
};
