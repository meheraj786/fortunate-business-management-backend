const Account = require("../models/account.model");
const Transaction = require("../models/transaction.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");

async function createAccount(req, res, next) {
  try {
    const {
      accountType,
      accountName,
      initialBalance,
      accountHolderName,
      bankName,
      branchName,
      accountNumber,
      swiftCode,
      serviceName,
      mobileNumber,
      routingNumber,
    } = req.body;

    const validationErrors = [];
    if (!accountType) {
      validationErrors.push({
        field: "accountType",
        message: "Account type is required",
      });
    }
    if (!accountName) {
      validationErrors.push({
        field: "accountName",
        message: "Account name is required",
      });
    }

    if (validationErrors.length > 0) {
      return next(new ApiError(400, "Validation failed", validationErrors));
    }

    const account = await Account.create({
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
    });

    return res
      .status(201)
      .json(new ApiResponse(201, account, "Account created successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function getAllAccounts(req, res, next) {
  try {
    const accounts = await Account.find();
    return res
      .status(200)
      .json(new ApiResponse(200, accounts, "Accounts fetched successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
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
    next(new ApiError(500, error.message));
  }
}

async function updateAccount(req, res, next) {
  try {
    const { id } = req.params;
    const updateData = req.body;

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
    next(new ApiError(500, error.message));
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
    next(new ApiError(500, error.message));
  }
}

module.exports = {
  createAccount,
  getAllAccounts,
  getAccountById,
  updateAccount,
  deleteAccount,
};
