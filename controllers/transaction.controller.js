const Transaction = require("../models/transaction.model");
const Trash = require("../models/trash.model"); 
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const mongoose = require("mongoose");

/* ================= GET TRANSACTION DETAILS ================= */
async function getTransactionDetails(req, res, next) {
  try {
    const { id } = req.params;
    if (!id) return next(new ApiError(400, "Transaction ID is required."));

    const results = await Transaction.aggregate([
      { 
        $match: { 
          _id: new mongoose.Types.ObjectId(id),
          isDeleted: { $ne: true } // শুধুমাত্র ডিলিট না হওয়া ডাটা
        } 
      },
      {
        $lookup: {
          from: "accounts",
          localField: "accountId",
          foreignField: "_id",
          as: "account",
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
      { $unwind: { path: "$account", preserveNullAndEmptyArrays: true } },
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
      { $project: { saleRef: 0, lcRef: 0 } },
    ]);

    if (results.length === 0) {
      return next(new ApiError(404, "Transaction not found or has been deleted."));
    }

    return res.status(200).json(new ApiResponse(200, results[0], "Transaction details fetched successfully."));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

/* ================= GET ALL TRANSACTIONS ================= */
async function getAllTransactions(req, res, next) {
  try {
    const {
      page = 1, limit = 10, transactionType, category,
      paymentMethod, search, sortBy = "date", sortOrder = "desc",
    } = req.query;

    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;

    // --- Filter Stage ---
    const matchQuery = { isDeleted: { $ne: true } }; // ডিলিট হওয়া ডাটা বাদ
    if (transactionType) matchQuery.transactionType = transactionType;
    if (category) matchQuery.category = category;
    if (paymentMethod) matchQuery.paymentMethod = paymentMethod;
    if (search) matchQuery.description = { $regex: search, $options: "i" };

    const sort = { [sortBy]: sortOrder === "asc" ? 1 : -1 };

    const pipeline = [
      { $match: matchQuery },
      {
        $facet: {
          data: [
            { $sort: sort },
            { $skip: skip },
            { $limit: limitNum },
            {
              $lookup: {
                from: "accounts",
                localField: "accountId",
                foreignField: "_id",
                as: "account",
              },
            },
            { $unwind: { path: "$account", preserveNullAndEmptyArrays: true } },
          ],
          metadata: [{ $count: "total" }],
          categories: [
            { $group: { _id: "$category" } },
            { $project: { _id: 0, category: "$_id" } },
          ],
        },
      },
    ];

    const result = await Transaction.aggregate(pipeline);
    const transactions = result[0].data;
    const totalCount = result[0].metadata[0]?.total || 0;
    const categories = result[0].categories.map((c) => c.category);

    res.status(200).json(new ApiResponse(200, {
      transactions: {
        docs: transactions,
        totalDocs: totalCount,
        limit: limitNum,
        totalPages: Math.ceil(totalCount / limitNum),
        page: pageNum,
      },
      categories,
    }, "Transactions fetched successfully."));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

/* ================= GET STATS (Excluded Deleted) ================= */
async function getTransactionStats(req, res, next) {
  try {
    const { startDate, endDate, transactionType, category, paymentMethod, accountId } = req.query;

    const matchQuery = { isDeleted: { $ne: true } };

    if (startDate || endDate) {
      matchQuery.date = {};
      if (startDate) matchQuery.date.$gte = new Date(startDate);
      if (endDate) matchQuery.date.$lte = new Date(endDate);
    }
    if (transactionType) matchQuery.transactionType = transactionType;
    if (category) matchQuery.category = category;
    if (paymentMethod) matchQuery.paymentMethod = paymentMethod;
    if (accountId) matchQuery.accountId = new mongoose.Types.ObjectId(accountId);

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
          ],
        },
      },
    ]);

    const result = stats[0];
    const formattedStats = {
      totalTransactionsCount: result.overallStats[0]?.totalTransactionsCount || 0,
      totalAmount: result.overallStats[0]?.totalAmount || 0,
      totalBankTransactionsAmount: result.paymentMethodStats.find(p => p._id === 'Bank')?.totalAmount || 0,
      totalCashTransactionsAmount: result.paymentMethodStats.find(p => p._id === 'Cash')?.totalAmount || 0,
      totalMobileBankingTransactionsAmount: result.paymentMethodStats.find(p => p._id === 'Mobile Banking')?.totalAmount || 0,
    };

    res.status(200).json(new ApiResponse(200, formattedStats, "Stats fetched successfully."));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

/* ================= GET TRANSACTIONS BY ACCOUNT ================= */
async function getTransactionsByAccount(req, res, next) {
  try {
    const { accountId } = req.params;
    const { page = 1, limit = 10, search } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const matchQuery = { 
      accountId: new mongoose.Types.ObjectId(accountId),
      isDeleted: { $ne: true } 
    };

    if (search) matchQuery.description = { $regex: search, $options: "i" };

    const [transactions, total] = await Promise.all([
      Transaction.find(matchQuery).sort({ date: -1 }).skip(skip).limit(parseInt(limit)),
      Transaction.countDocuments(matchQuery)
    ]);

    res.status(200).json(new ApiResponse(200, {
      transactions: { docs: transactions, totalDocs: total, page: parseInt(page), limit: parseInt(limit) }
    }, "Account transactions fetched."));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

/* ================= DELETE TRANSACTION (SOFT) ================= */
async function deleteTransaction(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const deletedBy = req.user?._id || req.cookies?.userId || null;

    if (!id) throw new ApiError(400, "Transaction ID is required.");

    const transaction = await Transaction.findOneAndUpdate(
      { _id: id, isDeleted: { $ne: true } },
      { isDeleted: true },
      { new: true, session }
    );

    if (!transaction) {
      throw new ApiError(404, "Transaction not found or already deleted.");
    }

    await Trash.create([{
      docId: transaction._id,
      model: "Transaction",
      deletedBy,
    }], { session });

    await session.commitTransaction();
    session.endSession();

    return res.status(200).json(new ApiResponse(200, null, "Transaction moved to trash successfully."));
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    next(error);
  }
}

module.exports = {
  getAllTransactions,
  getTransactionDetails,
  getTransactionStats,
  getTransactionsByAccount,
  deleteTransaction,
};