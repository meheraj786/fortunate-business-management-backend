const Transaction = require("../models/transaction.model");
const BankAccount = require("../models/bank.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");

async function createTransaction(req, res, next) {
  try {
    const {
      bankAccount: bankAccountId,
      date,
      description,
      type,
      amount,
      source,
      reference,
    } = req.body;

    if (!bankAccountId || !date || !description || !type || !amount) {
      return next(
        new ApiError(
          400,
          "Bank account, date, description, type, and amount are required"
        )
      );
    }

    const bankAccount = await BankAccount.findById(bankAccountId);
    if (!bankAccount) {
      return next(new ApiError(404, "Bank account not found"));
    }

    const transaction = await Transaction.create({
      bankAccount: bankAccountId,
      date,
      description,
      type,
      amount,
      source,
      reference,
    });

    if (type === "Credit") {
      bankAccount.balance += amount;
    } else if (type === "Debit") {
      bankAccount.balance -= amount;
    }
    await bankAccount.save();

    return res
      .status(201)
      .json(new ApiResponse(201, transaction, "Transaction created successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function getAllTransactions(req, res, next) {
  try {
    const transactions = await Transaction.find()
      .populate("bankAccount", "accountName accountType")
      .sort({ date: -1 });
    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          transactions,
          "All transactions fetched successfully"
        )
      );
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function getTransactionById(req, res, next) {
  try {
    const { id } = req.params;
    const transaction = await Transaction.findById(id).populate(
      "bankAccount",
      "accountName accountType"
    );

    if (!transaction) {
      return next(new ApiError(404, "Transaction not found"));
    }

    return res
      .status(200)
      .json(new ApiResponse(200, transaction, "Transaction fetched successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function getTransactionsByAccountId(req, res, next) {
  try {
    const { accountId } = req.params;
    const transactions = await Transaction.find({ bankAccount: accountId })
      .populate("bankAccount", "accountName accountType")
      .sort({ date: -1 });

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          transactions,
          "Transactions for account fetched successfully"
        )
      );
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function deleteTransaction(req, res, next) {
  try {
    const { id } = req.params;
    const transaction = await Transaction.findByIdAndDelete(id);

    if (!transaction) {
      return next(new ApiError(404, "Transaction not found"));
    }

    const bankAccount = await BankAccount.findById(transaction.bankAccount);
    if (bankAccount) {
      if (transaction.type === "Credit") {
        bankAccount.balance -= transaction.amount;
      } else if (transaction.type === "Debit") {
        bankAccount.balance += transaction.amount;
      }
      await bankAccount.save();
    }

    return res
      .status(200)
      .json(new ApiResponse(200, transaction, "Transaction deleted successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function getTransactionStats(req, res, next) {
  try {
    const stats = await Transaction.aggregate([
      // Stage 1: Lookup bank account details for each transaction
      {
        $lookup: {
          from: "bankaccounts", // The actual collection name for the BankAccount model
          localField: "bankAccount",
          foreignField: "_id",
          as: "accountDetails",
        },
      },
      {
        $unwind: "$accountDetails",
      },
      // Stage 2: Group by individual bank account to get per-account stats
      {
        $group: {
          _id: "$bankAccount",
          accountName: { $first: "$accountDetails.accountName" },
          accountType: { $first: "$accountDetails.accountType" },
          totalTransactions: { $sum: 1 },
          totalCredit: {
            $sum: { $cond: [{ $eq: ["$type", "Credit"] }, "$amount", 0] },
          },
          totalDebit: {
            $sum: { $cond: [{ $eq: ["$type", "Debit"] }, "$amount", 0] },
          },
        },
      },
      // Stage 3: Group everything to calculate overall and type-based stats
      {
        $group: {
          _id: null,
          individualAccountStats: { $push: "$$ROOT" },
          totalTransactions: { $sum: "$totalTransactions" },
          overallTotalCredit: { $sum: "$totalCredit" },
          overallTotalDebit: { $sum: "$totalDebit" },
          totalBankTransactions: {
            $sum: {
              $cond: [{ $eq: ["$accountType", "Bank"] }, "$totalTransactions", 0],
            },
          },
          totalMobileBankingTransactions: {
            $sum: {
              $cond: [
                { $eq: ["$accountType", "Mobile Banking"] },
                "$totalTransactions",
                0,
              ],
            },
          },
          totalBankCredit: {
            $sum: {
              $cond: [{ $eq: ["$accountType", "Bank"] }, "$totalCredit", 0],
            },
          },
          totalBankDebit: {
            $sum: {
              $cond: [{ $eq: ["$accountType", "Bank"] }, "$totalDebit", 0],
            },
          },
          totalMobileBankingCredit: {
            $sum: {
              $cond: [
                { $eq: ["$accountType", "Mobile Banking"] },
                "$totalCredit",
                0,
              ],
            },
          },
          totalMobileBankingDebit: {
            $sum: {
              $cond: [
                { $eq: ["$accountType", "Mobile Banking"] },
                "$totalDebit",
                0,
              ],
            },
          },
        },
      },
      // Stage 4: Project to reshape the final output
      {
        $project: {
          _id: 0,
          overall: {
            totalTransactions: "$totalTransactions",
            totalCredit: "$overallTotalCredit",
            totalDebit: "$overallTotalDebit",
          },
          byType: {
            bank: {
              count: "$totalBankTransactions",
              totalCredit: "$totalBankCredit",
              totalDebit: "$totalBankDebit",
            },
            mobileBanking: {
              count: "$totalMobileBankingTransactions",
              totalCredit: "$totalMobileBankingCredit",
              totalDebit: "$totalMobileBankingDebit",
            },
          },
          individualAccounts: "$individualAccountStats",
        },
      },
    ]);

    const finalStats = stats[0] || {
      overall: { totalTransactions: 0, totalCredit: 0, totalDebit: 0 },
      byType: {
        bank: { count: 0, totalCredit: 0, totalDebit: 0 },
        mobileBanking: { count: 0, totalCredit: 0, totalDebit: 0 },
      },
      individualAccounts: [],
    };

    return res
      .status(200)
      .json(
        new ApiResponse(200, finalStats, "Transaction stats fetched successfully")
      );
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

module.exports = {
  createTransaction,
  getAllTransactions,
  getTransactionById,
  getTransactionsByAccountId,
  deleteTransaction,
  getTransactionStats,
};
