const Transaction = require("../models/transaction.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const Trash = require("../models/trash.model");

async function getTransactionDetails(req, res, next) {
  try {
    const { id } = req.params; // Transaction ID
    if (!id) {
      return next(new ApiError(400, "Transaction ID is required."));
    }
    const mongoose = require("mongoose");

    const results = await Transaction.aggregate([
      { $match: { _id: new mongoose.Types.ObjectId(id) } },
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
    ]);

    if (results.length === 0) {
      return next(new ApiError(404, "Transaction not found."));
    }
    const transaction = results[0];

    return res
      .status(200)
      .json(
        new ApiResponse(200, transaction, "Transaction details fetched successfully.")
      );
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(new ApiError(409, `A document with the same ${field} '${value}' already exists.`)); // Generic message
    }
    // Handle Mongoose validation errors
    if (error.name === 'ValidationError') {
      const firstErrorField = Object.keys(error.errors)[0];
      let userFriendlyMessage = "Validation failed.";

      if (firstErrorField) {
        userFriendlyMessage = `The field ${firstErrorField} is required.`;
      }
      return next(new ApiError(400, userFriendlyMessage, error.errors));
    }
    next(new ApiError(500, error.message || "Something went wrong"));
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
    const matchQuery = {};
    if (transactionType) matchQuery.transactionType = transactionType;
    if (category) matchQuery.category = category;
    if (paymentMethod) matchQuery.paymentMethod = paymentMethod;
    if (search) matchQuery.description = { $regex: search, $options: "i" };

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
    const categories = result[0].categories.map(c => c.category);

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
        new ApiResponse(200, response, "All transactions fetched successfully.")
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
          `A document with the same ${field} '${value}' already exists.`
        )
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
    next(new ApiError(500, error.message || "Something went wrong"));
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
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(new ApiError(409, `A document with the same ${field} '${value}' already exists.`)); // Generic message
    }
    // Handle Mongoose validation errors
    if (error.name === 'ValidationError') {
      const firstErrorField = Object.keys(error.errors)[0];
      let userFriendlyMessage = "Validation failed.";

      if (firstErrorField) {
        userFriendlyMessage = `The field ${firstErrorField} is required.`;
      }
      return next(new ApiError(400, userFriendlyMessage, error.errors));
    }
    next(new ApiError(500, error.message || "Something went wrong"));
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
    const mongoose = require("mongoose");

    const pipeline = [];

    // --- Main Filtering Stage ---
    const matchQuery = { accountId: new mongoose.Types.ObjectId(accountId) };
    if (category) matchQuery.category = category;
    if (transactionType) matchQuery.transactionType = transactionType;
    if (paymentMethod) matchQuery.paymentMethod = paymentMethod;
    if (search) matchQuery.description = { $regex: search, $options: "i" };

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
    const categories = result[0].categories.map(c => c.category);

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
          "Transactions for the account fetched successfully."
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
  getAllTransactions,
  getTransactionDetails,
  getTransactionStats,
  getTransactionsByAccount,
};
