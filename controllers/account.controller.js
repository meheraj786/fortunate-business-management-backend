const Account = require("../models/account.model");
const Transaction = require("../models/transaction.model");
const DailyCash = require("../models/dailyCash.model");
const Trash = require("../models/trash.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const mongoose = require("mongoose");

// --- CREATE ---
async function createAccount(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { initialBalance = 0, ...rest } = req.body;
    const accountArray = await Account.create(
      [{ ...rest, balance: initialBalance }],
      { session }
    );
    const createdAccount = accountArray[0];

    if (initialBalance > 0) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const dailyCash = await DailyCash.findOne({ date: today }).session(
        session
      );
      if (!dailyCash || dailyCash.status === "Closed")
        throw new ApiError(400, "Daily cash is closed.");

      await Transaction.create(
        [
          {
            accountId: createdAccount._id,
            date: new Date(),
            transactionType: "Income",
            amount: initialBalance,
            name: "Initial Balance",
            source: "Account",
            paymentMethod: createdAccount.accountType,
            category: "Initial Balance",
          },
        ],
        { session }
      );
    }
    await session.commitTransaction();
    res.status(201).json(new ApiResponse(201, createdAccount, "Success"));
  } catch (error) {
    await session.abortTransaction();
    next(new ApiError(400, error.message));
  } finally {
    session.endSession();
  }
}

// --- GET ALL ---
async function getAllAccounts(req, res, next) {
  try {
    const accounts = await Account.find({ status: "Active" });
    res.status(200).json(new ApiResponse(200, accounts, "Fetched"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

// --- GET BY ID ---
async function getAccountById(req, res, next) {
  try {
    const account = await Account.findById(req.params.id);
    if (!account) throw new ApiError(404, "Account not found");
    res.status(200).json(new ApiResponse(200, account, "Fetched"));
  } catch (error) {
    next(error);
  }
}

// --- UPDATE ---
async function updateAccount(req, res, next) {
  try {
    if (req.body.balance) delete req.body.balance;
    const updated = await Account.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    if (!updated) throw new ApiError(404, "Not found");
    res.status(200).json(new ApiResponse(200, updated, "Updated"));
  } catch (error) {
    next(error);
  }
}

// --- DELETE (SOFT) ---
async function deleteAccount(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const account = await Account.findById(id).session(session);
    if (!account) throw new ApiError(404, "Not found");
    if (account.balance !== 0) throw new ApiError(400, "Balance must be zero");

    account.isDeleted = true;
    await account.save({ session });

    await Trash.create(
      [{ docId: id, model: "Account", deletedBy: req.user?._id }],
      { session }
    );

    await session.commitTransaction();
    res.status(200).json(new ApiResponse(200, null, "Deleted"));
  } catch (error) {
    await session.abortTransaction();
    next(error);
  } finally {
    session.endSession();
  }
}

// --- DETAILS (FIXED AGGREGATION) ---
async function getAccountDetails(req, res, next) {
  try {
    const results = await Account.aggregate([
      {
        $match: {
          _id: new mongoose.Types.ObjectId(req.params.id),
          isDeleted: { $ne: true }, // পুরাতন ডাটা পাওয়ার জন্য $ne: true ব্যবহার করা হয়েছে
        },
      },
      {
        $lookup: {
          from: "transactions",
          localField: "_id",
          foreignField: "accountId",
          as: "transactions",
        },
      },
      {
        $addFields: {
          totalIncome: {
            $sum: {
              $map: {
                input: {
                  $filter: {
                    input: "$transactions",
                    as: "t",
                    cond: { $eq: ["$$t.transactionType", "Income"] },
                  },
                },
                as: "i",
                in: "$$i.amount",
              },
            },
          },
          totalExpense: {
            $sum: {
              $map: {
                input: {
                  $filter: {
                    input: "$transactions",
                    as: "t",
                    cond: { $eq: ["$$t.transactionType", "Expense"] },
                  },
                },
                as: "e",
                in: "$$e.amount",
              },
            },
          },
          transactionCount: { $size: "$transactions" },
        },
      },
      { $project: { transactions: 0 } },
    ]);

    if (!results.length) throw new ApiError(404, "Account not found");
    res.status(200).json(new ApiResponse(200, results[0], "Success"));
  } catch (error) {
    next(error);
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
