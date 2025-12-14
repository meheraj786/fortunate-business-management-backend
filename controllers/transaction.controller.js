const Transaction = require("../models/transaction.model");
const Account = require("../models/account.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");

async function createTransaction(req, res, next) {
  try {
    const {
      account: accountId,
      date,
      description,
      type,
      amount,
      source,
      reference,
    } = req.body;

    const validationErrors = [];
    if (!accountId) {
      validationErrors.push({
        field: "account",
        message: "Account is required",
      });
    }
    if (!date) {
      validationErrors.push({ field: "date", message: "Date is required" });
    }
    if (!description) {
      validationErrors.push({
        field: "description",
        message: "Description is required",
      });
    }
    if (!type) {
      validationErrors.push({ field: "type", message: "Type is required" });
    }
    if (!amount) {
      validationErrors.push({ field: "amount", message: "Amount is required" });
    }

    if (validationErrors.length > 0) {
      return next(new ApiError(400, "Validation failed", validationErrors));
    }

    const account = await Account.findById(accountId);
    if (!account) {
      return next(new ApiError(404, "Account not found"));
    }

    const transaction = await Transaction.create({
      account: accountId,
      date,
      description,
      type,
      amount,
      source,
      reference,
    });

    if (type === "Credit") {
      account.balance += amount;
    } else if (type === "Debit") {
      account.balance -= amount;
    }
    await account.save();

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
      .populate("account", "accountName accountType")
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
      "account",
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
    const transactions = await Transaction.find({ account: accountId })
      .populate("account", "accountName accountType")
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
    const transaction = await Transaction.findById(id);

    if (!transaction) {
      return next(new ApiError(404, "Transaction not found"));
    }

    // Prevent deletion if the transaction is not a manual entry
    if (transaction.source !== "Manual Entry") {
      return next(
        new ApiError(
          400,
          `Cannot delete an automatic transaction. This transaction originated from '${transaction.source}'.`
        )
      );
    }

    const deletedTransaction = await Transaction.findByIdAndDelete(id);
    if (!deletedTransaction) {
      // This case is unlikely if the first findById succeeded, but it's good practice
      return next(new ApiError(404, "Transaction not found for deletion"));
    }

    const account = await Account.findById(transaction.account);
    if (account) {
      if (transaction.type === "Credit") {
        account.balance -= transaction.amount;
      } else if (transaction.type === "Debit") {
        account.balance += transaction.amount;
      }
      await account.save();
    }

    return res
      .status(200)
      .json(new ApiResponse(200, deletedTransaction, "Transaction deleted successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function getTransactionStats(req, res, next) {
  try {
    const stats = await Transaction.aggregate([
      // Stage 1: Lookup account details for each transaction
      {
        $lookup: {
          from: "accounts", // The actual collection name for the Account model
          localField: "account",
          foreignField: "_id",
          as: "accountDetails",
        },
      },
      {
        $unwind: "$accountDetails",
      },
      // Stage 2: Group by individual account to get per-account stats
      {
        $group: {
          _id: "$account",
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
