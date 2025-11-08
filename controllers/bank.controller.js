const BankAccount = require("../models/bank.model");
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

    if (!accountType || !accountName) {
      return next(new ApiError(400, "Account type and name are required"));
    }

    const account = await BankAccount.create({
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
    const accounts = await BankAccount.find();
    return res
      .status(200)
      .json(new ApiResponse(200, accounts, "Accounts fetched successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

const Transaction = require("../models/transaction.model");

async function getAccountById(req, res, next) {
  try {
    const { id } = req.params;
    const account = await BankAccount.findById(id);

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

    const updatedAccount = await BankAccount.findByIdAndUpdate(id, updateData, {
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
    const deletedAccount = await BankAccount.findByIdAndDelete(id);

    if (!deletedAccount) {
      return next(new ApiError(404, "Account not found"));
    }

    // Also delete all transactions associated with this account
    await Transaction.deleteMany({ bankAccount: id });

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
