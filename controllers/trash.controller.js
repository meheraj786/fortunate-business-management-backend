const mongoose = require("mongoose");
const Trash = require("../models/trash.model");
const { ApiResponse } = require("../utils/ApiResponse");
const { ApiError } = require("../utils/ApiError");
const logger = require("../utils/logger");
const { startOfDay, now } = require("../utils/timezone.util"); // Import startOfDay

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
      deletedAt: now(),
    },
    { upsert: true, new: true }
  );
};


const restoreFromTrash = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { id } = req.params;

    // 1️⃣ Trash entry
    const trashEntry = await Trash.findById(id).session(session);
    if (!trashEntry) throw new ApiError(404, "Trash entry not found");

    const { docId, model: modelName } = trashEntry;
    const TargetModel = mongoose.model(modelName);

    // 2️⃣ Restore main document
    let restoredDoc = await TargetModel.findOneAndUpdate(
      { _id: docId, isDeleted: true },
      { $set: { isDeleted: false, status: "Active" } },
      { session, new: true }
    );

    if (!restoredDoc)
      throw new ApiError(404, `${modelName} not found to restore`);

    /* =====================================================
        TRANSACTION RESTORE
    ===================================================== */
    if (modelName === "Transaction") {
      const Account = mongoose.model("Account");
      const DailyCash = mongoose.model("DailyCash");

      const date = startOfDay(new Date(restoredDoc.date));

      const dailyCash = await DailyCash.findOne({
        date,
        status: "Open",
      }).session(session);

      if (!dailyCash)
        throw new ApiError(400, `Daily cash closed for ${date.toDateString()}`);

      const account = await Account.findById(restoredDoc.accountId).session(
        session
      );

      if (!account) throw new ApiError(404, "Account not found");

      if (restoredDoc.transactionType === "Income") {
        account.balance += restoredDoc.amount;
      } else {
        if (account.balance < restoredDoc.amount) {
          throw new ApiError(400, "Insufficient balance to restore expense");
        }
        account.balance -= restoredDoc.amount;
      }

      await account.save({ session });
    }

    /* =====================================================
        SALE RESTORE
    ===================================================== */
    if (modelName === "Sale") {
      const Product = mongoose.model("Product");
      const Account = mongoose.model("Account");
      const Transaction = mongoose.model("Transaction");

      // The document is already restored by the initial update. We re-fetch it here to populate its dependencies.
      const saleToRestore = await TargetModel.findById(docId)
        .populate("unit")
        .populate({ path: "product", populate: { path: "unit" } })
        .session(session);

      if (!saleToRestore) {
        throw new ApiError(404, "Original Sale document not found to restore.");
      }
      
      // 🔹 Restore stock using populated data
      const product = saleToRestore.product;
      if (product && saleToRestore.unit && product.unit) {
         if (product.unit.type !== saleToRestore.unit.type) {
            throw new ApiError(400, "Cannot restore sale. Product and sale units are incompatible.");
        }
        const deductQty = 
            (saleToRestore.quantity * saleToRestore.unit.conversionFactor) / 
            product.unit.conversionFactor;

        if (product.quantity < deductQty) {
            throw new ApiError(400, "Insufficient stock to restore this sale.");
        }

        await Product.findByIdAndUpdate(
          product._id,
          { $inc: { quantity: -deductQty } },
          { session }
        );
      }
      
      // Update the sale document's status
      saleToRestore.isDeleted = false;
      saleToRestore.status = "Active";
      // Re-assign to the outer scope variable so the final response is populated
      restoredDoc = await saleToRestore.save({ session });

      // DailyCash Gatekeeper Check for financial restorations
      // This check is required if there are payments to be financially adjusted,
      // as these adjustments involve creating new transactions.
      if (restoredDoc.payments.length > 0) {
        const DailyCash = mongoose.model("DailyCash");
        const today = startOfDay(now());

        const dailyCash = await DailyCash.findOne({
          date: today,
          status: "Open",
        }).session(session);

        if (!dailyCash) {
          throw new ApiError(
            400,
            `Daily cash is closed for ${today.toDateString()}. Cannot process financial restorations for the sale.`
          );
        }
      }

      // 🔹 Restore payments → account + transaction
      for (const payment of restoredDoc.payments || []) {
        if (!["Bank", "Mobile Banking", "Cash"].includes(payment.method)) {
          continue;
        }

        const account = await Account.findById(payment.accountId).session(session);
        if (!account) continue;

        account.balance += payment.amount;
        await account.save({ session });
        await Transaction.create(
          [
            {
              name: `Restored Sale Payment: ${restoredDoc.saleId}`,
              accountId: payment.accountId,
              date: now(),
              description: `Payment for restored Sale: ${restoredDoc.saleId}`,
              transactionType: "Income",
              amount: payment.amount,
              source: "Auto",
              category: "Sales Restore",
              paymentMethod: payment.method,
              reference: restoredDoc._id,
              referenceModel: "Sale",
            },
          ],
          { session }
        );
      }
    }

    /* =====================================================
        LC RESTORE
    ===================================================== */
    if (modelName === "LC") {
      const Account = mongoose.model("Account");
      const Transaction = mongoose.model("Transaction");
      const DailyCash = mongoose.model("DailyCash");

      const today = startOfDay(now());

      const dailyCash = await DailyCash.findOne({
        date: today,
        status: "Open",
      }).session(session);

      if (!dailyCash)
        throw new ApiError(
          400,
          `Daily cash closed for ${today.toDateString()}`
        );

      const sections = [
        restoredDoc.financialInfo,
        restoredDoc.shippingCustomsInfo,
        restoredDoc.agentTransportInfo,
        restoredDoc.otherExpenses,
      ];

      for (const section of sections) {
        if (!section?.costs?.length) continue;

        for (const cost of section.costs) {
          if (!cost.accountId || cost.amount <= 0) continue;

          const account = await Account.findById(cost.accountId).session(
            session
          );

          if (!account || account.balance < cost.amount) {
            throw new ApiError(
              400,
              `Insufficient balance for LC cost: ${cost.name}`
            );
          }

          // deduct again (LC restore = expense again)
          account.balance -= cost.amount;
          await account.save({ session });

          await Transaction.create(
            [
              {
                name: `LC Restore: ${cost.name}`,
                accountId: cost.accountId,
                date: now(),
                description: `Restored LC Cost: ${cost.name} for LC ${restoredDoc.basicInfo.lcNumber}`,
                transactionType: "Expense",
                amount: cost.amount,
                source: "Auto",
                category: "LC Restore",
                paymentMethod: cost.paymentMethod,
                reference: restoredDoc._id,
                referenceModel: "LC",
              },
            ],
            { session }
          );
        }
      }
    }

    // 3️⃣ Remove from trash
    await Trash.findByIdAndDelete(id).session(session);

    await session.commitTransaction();
    session.endSession();

    res
      .status(200)
      .json(
        new ApiResponse(200, restoredDoc, `${modelName} restored successfully`)
      );
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    if (error instanceof ApiError) {
      return next(error);
    }
    logger.error(error);
    next(new ApiError(500, "Failed to restore item from trash. Please try again."));
  }
};

const getAllTrash = async (req, res) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const { module: moduleFilter, warehouseId } = req.query;

    const filter = {};
    if (moduleFilter && moduleFilter !== "undefined" && moduleFilter !== "") {
      filter.model = moduleFilter;
    }

    // Add specific filtering for Product module by warehouseId
    if (moduleFilter === "Product" && warehouseId) {
        filter["metadata.warehouseId"] = new mongoose.Types.ObjectId(warehouseId);
    }

    const [trash, total] = await Promise.all([
      Trash.find(filter)
        .populate("deletedBy", "name email")
        .populate({
          path: "docId",
          match: { isDeleted: { $in: [true, false] } },
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
    next(new ApiError(500, "Failed to load trash"));
  }
};

const deleteTrashPermanently = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;

    const trashEntry = await Trash.findById(id).session(session);

    if (!trashEntry) {
      throw new ApiError(404, "Trash entry not found");
    }

    const { docId, model: modelName } = trashEntry;
    const TargetModel = mongoose.model(modelName);

    // Attempt to delete the original document
    const originalDoc = await TargetModel.findByIdAndDelete(docId, { session });

    if (!originalDoc) {
      logger.warn(
        `Original document (ID: ${docId}, Model: ${modelName}) not found during permanent trash deletion. It might have been manually deleted.`
      );
    }

    // Delete the trash entry itself
    await Trash.findByIdAndDelete(id, { session });

    await session.commitTransaction();
    session.endSession();

    return res
      .status(200)
      .json(new ApiResponse(200, null, "Item permanently deleted from trash"));
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    if (err instanceof ApiError) {
      return next(err);
    }
    logger.error("Permanent delete error:", err);
    next(new ApiError(500, "Failed to permanently delete trash item"));
  }
};

const getTrashDetailById = async (id) => {
  try {
    const trash = await Trash.findById(id).populate("deletedBy", "name email");
    if (!trash) {
      throw new Error("Trash entry not found");
    }

    const { docId, model: modelName, deletedBy, deletedAt } = trash;

    const TargetModel = mongoose.model(modelName);
    const originalDoc = await TargetModel.findById(docId).lean();

    const response = {
      trashId: id,
      model: modelName,
      deletedBy: deletedBy || null,
      deletedAt: deletedAt || null,
      originalDoc: originalDoc ? originalDoc : null,
      isDeleted: originalDoc ? originalDoc.isDeleted : true,
    };

    return response;
  } catch (err) {
    logger.error("GetTrashDetailById Error:", err);
    throw err;
  }
};

module.exports = {
  moveToTrash,
  restoreFromTrash,
  getAllTrash,
  deleteTrashPermanently,
  getTrashDetailById,
};