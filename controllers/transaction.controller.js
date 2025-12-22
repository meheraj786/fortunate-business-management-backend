const Transaction = require("../models/transaction.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");

async function getTransactionDetails(req, res, next) {
  try {
    const { id } = req.params; // Transaction ID
    if (!id) {
      return next(new ApiError(400, "Transaction ID is required."));
    }

    const transaction = await Transaction.findById(id)
      .populate("accountId", "accountName accountType") // Populate account details
      .populate("reference", "saleId basicInfo.lcNumber"); // Populate Sale/LC details based on referenceModel

    if (!transaction) {
      return next(new ApiError(404, "Transaction not found."));
    }

    return res
      .status(200)
      .json(
        new ApiResponse(200, transaction, "Transaction details fetched successfully.")
      );
  } catch (error) {
    next(new ApiError(500, error.message || "Error fetching transaction details."));
  }
}

async function getAllTransactions(req, res, next) {
  try {
    const {
      page = 1,
      limit = 10,
      startDate,
      endDate,
      transactionType,
      category,
      paymentMethod,
      accountId,
      search,
      sortBy = "date",
      sortOrder = "desc",
    } = req.query;

    const query = {};

    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate) query.date.$lte = new Date(endDate);
    }
    if (transactionType) query.transactionType = transactionType;
    if (category) query.category = category;
    if (paymentMethod) query.paymentMethod = paymentMethod;
    if (accountId) query.accountId = accountId;

    if (search) {
      const searchRegex = new RegExp(search, "i");
      query.$or = [
        { name: searchRegex },
        { description: searchRegex },
        { category: searchRegex },
      ];
    }

    const options = {
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
      sort: { [sortBy]: sortOrder === "asc" ? 1 : -1 },
      populate: [
        { path: "accountId", select: "accountName accountType" },
        { path: "reference", select: "saleId basicInfo.lcNumber" },
      ],
      lean: true, // Return plain JavaScript objects
    };

    const transactions = await Transaction.paginate(query, options);

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          transactions,
          "All transactions fetched successfully."
        )
      );
  } catch (error) {
    next(
      new ApiError(500, error.message || "Error fetching all transactions.")
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

    const matchQuery = {};

    if (startDate || endDate) {
      matchQuery.date = {};
      if (startDate) matchQuery.date.$gte = new Date(startDate);
      if (endDate) matchQuery.date.$lte = new Date(endDate);
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
                }
            }
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
                }
            }
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
      averageTransactionAmount: stats[0]?.overall?.averageTransactionAmount || 0,
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
        formattedStats.totalMobileBankingTransactionsAmount = pmStat.totalAmount;
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
          "Transaction statistics fetched successfully."
        )
      );
  } catch (error) {
    next(
      new ApiError(500, error.message || "Error fetching transaction statistics.")
    );
  }
}

module.exports = {
  getAllTransactions,
  getTransactionDetails,
  getTransactionStats,
};
