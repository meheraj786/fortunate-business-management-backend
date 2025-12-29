const mongoose = require("mongoose");
const Trash = require("../models/trash.model");
const { ApiResponse } = require("../utils/ApiResponse");
const { ApiError } = require("../utils/ApiError");
const logger = require("../utils/logger");


const moveToTrash = async ({ docId, modelName, deletedBy = null }) => {
  if (!docId || !modelName) {
    throw new Error("docId and modelName are required");
  }

  await Trash.findOneAndUpdate(
    { docId, model: modelName },
    {
      docId,
      model: modelName,
      deletedBy,
      deletedAt: new Date(),
    },
    { upsert: true, new: true }
  );
};



const restoreFromTrash = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;

    const trashEntry = await Trash.findById(id).session(session);
    if (!trashEntry) throw new Error("Trash entry not found");

    const { docId, model: modelName } = trashEntry;
    const TargetModel = mongoose.model(modelName);

    const restoredDoc = await TargetModel.findOneAndUpdate(
      { _id: docId, isDeleted: true },
      { $set: { isDeleted: false, status: "Active" } },
      { session, new: true }
    );

    if (!restoredDoc) {
      throw new Error(`Original ${modelName} not found to restore`);
    }

    if (modelName === "Transaction") {
      const Account = mongoose.model("Account");
      const DailyCash = mongoose.model("DailyCash");

      const transDate = new Date(restoredDoc.date);
      transDate.setHours(0, 0, 0, 0);
      const dailySession = await DailyCash.findOne({ date: transDate, status: "Open" }).session(session);

      if (!dailySession) {
        throw new Error(`Cannot restore. Daily cash session for ${transDate.toDateString()} is closed.`);
      }

      const account = await Account.findById(restoredDoc.accountId).session(session);
      if (account) {
        if (restoredDoc.transactionType === "Income") {
          account.balance += restoredDoc.amount;
        } else if (restoredDoc.transactionType === "Expense") {
          if (account.balance < restoredDoc.amount) {
            throw new Error(`Insufficient balance in ${account.accountName} to restore this expense.`);
          }
          account.balance -= restoredDoc.amount;
        }
        await account.save({ session });
      }
    }

    await Trash.findByIdAndDelete(id).session(session);

    await session.commitTransaction();
    session.endSession();

    res.json({ success: true, message: `${modelName} restored and balance adjusted successfully` });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    res.status(500).json({ success: false, message: error.message });
  }
};




const getAllTrash = async (req, res) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const { module: moduleFilter } = req.query; 

    const filter = {};
    if (moduleFilter && moduleFilter !== "undefined" && moduleFilter !== "") {
      filter.model = moduleFilter; 
    }

    const [trash, total] = await Promise.all([
      Trash.find(filter)
        .populate("deletedBy", "name email")
        .populate({
          path: "docId",
          match: { isDeleted: { $in: [true, false] } } 
        })
        .sort({ deletedAt: -1 })
        .skip(skip)
        .limit(limit),
      Trash.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: {
        trash,
        total,
        page,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    logger.error("GetAllTrash Error:", err);
    res.status(500).json({ success: false, message: "Failed to load trash" });
  }
};


const deleteTrashPermanently = async (req, res) => {
  try {
    const trash = await Trash.findById(req.params.id);

    if (!trash) {
      return res.status(404).json({
        success: false,
        message: "Trash item not found",
      });
    }

    await trash.deleteOne();

    res.json({
      success: true,
      message: "Trash entry removed permanently",
    });
  } catch (err) {
    logger.error("Permanent delete error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to delete trash item",
    });
  }
};

module.exports = {
  moveToTrash,
  restoreFromTrash,
  getAllTrash,
  deleteTrashPermanently,
};
