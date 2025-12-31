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

// const restoreFromTrash = async (req, res) => {
//   const session = await mongoose.startSession();
//   session.startTransaction();
//   try {
//     const { id } = req.params;

//     const trashEntry = await Trash.findById(id).session(session);
//     if (!trashEntry) throw new Error("Trash entry not found");

//     const { docId, model: modelName } = trashEntry;
//     const TargetModel = mongoose.model(modelName);

//     const restoredDoc = await TargetModel.findOneAndUpdate(
//       { _id: docId, isDeleted: true },
//       { $set: { isDeleted: false, status: "Active" } },
//       { session, new: true }
//     );

//     if (!restoredDoc) {
//       throw new Error(`Original ${modelName} not found to restore`);
//     }

//     if (modelName === "Transaction") {
//       const Account = mongoose.model("Account");
//       const DailyCash = mongoose.model("DailyCash");

//       const transDate = new Date(restoredDoc.date);
//       transDate.setHours(0, 0, 0, 0);
//       const dailySession = await DailyCash.findOne({
//         date: transDate,
//         status: "Open",
//       }).session(session);

//       if (!dailySession) {
//         throw new Error(
//           `Cannot restore. Daily cash session for ${transDate.toDateString()} is closed.`
//         );
//       }

//       const account = await Account.findById(restoredDoc.accountId).session(
//         session
//       );
//       if (account) {
//         if (restoredDoc.transactionType === "Income") {
//           account.balance += restoredDoc.amount;
//         } else if (restoredDoc.transactionType === "Expense") {
//           if (account.balance < restoredDoc.amount) {
//             throw new Error(
//               `Insufficient balance in ${account.accountName} to restore this expense.`
//             );
//           }
//           account.balance -= restoredDoc.amount;
//         }
//         await account.save({ session });
//       }
//     }
//           if (modelName === "Sale") {
//         const Product = mongoose.model("Product");
//         const restoredProduct = await Product.findById(
//           restoredDoc.product
//         ).session(session);
//         if (restoredProduct) {
//           const deductQty =
//             (restoredDoc.quantity * restoredDoc.unit.conversionFactor) /
//             restoredProduct.unit.conversionFactor;
//           await Product.findByIdAndUpdate(
//             restoredProduct._id,
//             { $inc: { quantity: -deductQty } },
//             { session }
//           );
//         }
//       }
//       if (modelName === "Sale") {
//         const Account = mongoose.model("Account");
//         for (const payment of restoredDoc.payments) {
//           if (["bank", "mobile-banking", "cash"].includes(payment.method)) {
//             const account = await Account.findById(payment.accountId).session(
//               session
//             );
//             if (account) {
//               account.balance += payment.amount;
//               await account.save({ session });

//               const Transaction = mongoose.model("Transaction");
//               await Transaction.create(
//                 [
//                   {
//                     accountId: payment.accountId,
//                     date: new Date(),
//                     description: `Restored Sale: ${restoredDoc.saleId}`,
//                     transactionType: "Income",
//                     amount: payment.amount,
//                     source: "Auto",
//                     category: "Sales Restore",
//                     reference: restoredDoc._id,
//                     referenceModel: "Sale",
//                   },
//                 ],
//                 { session }
//               );
//             }
//           }
//         }
//       }

//     if (modelName === "LC") {
//   const Account = mongoose.model("Account");
//   const Transaction = mongoose.model("Transaction");
//   const DailyCash = mongoose.model("DailyCash");

//   // DailyCash check
//   const today = new Date();
//   today.setHours(0, 0, 0, 0);

//   const dailyCash = await DailyCash.findOne({
//     date: today,
//     status: "Open",
//   }).session(session);

//   if (!dailyCash) {
//     throw new Error(
//       `Daily cash is closed for ${today.toDateString()}. Cannot restore LC.`
//     );
//   }

//   // All cost sections
//   const sectionsWithCosts = [
//     restoredDoc.financialInfo,
//     restoredDoc.shippingCustomsInfo,
//     restoredDoc.agentTransportInfo,
//     restoredDoc.otherExpenses,
//   ];

//   for (const section of sectionsWithCosts) {
//     if (section?.costs?.length) {
//       for (const cost of section.costs) {
//         if (cost.accountId && cost.amount > 0) {
//           const account = await Account.findById(cost.accountId).session(session);

//           if (!account || account.balance < cost.amount) {
//             throw new Error(
//               `Insufficient balance in account to restore LC cost: ${cost.name}`
//             );
//           }

//           // Deduct balance again
//           account.balance -= cost.amount;
//           await account.save({ session });

//           // Create Expense transaction again
//           await Transaction.create(
//             [
//               {
//                 accountId: cost.accountId,
//                 date: new Date(),
//                 description: `Restored LC Cost: ${cost.name} for LC ${restoredDoc.basicInfo.lcNumber}`,
//                 transactionType: "Expense",
//                 amount: cost.amount,
//                 source: "Auto",
//                 category: "LC Restore",
//                 paymentMethod: cost.paymentMethod,
//                 reference: restoredDoc._id,
//                 referenceModel: "LC",
//               },
//             ],
//             { session }
//           );
//         }
//       }
//     }
//   }
// }

//     await Trash.findByIdAndDelete(id).session(session);

//     await session.commitTransaction();
//     session.endSession();

//     res.json({
//       success: true,
//       message: `${modelName} restored and balance adjusted successfully`,
//     });
//   } catch (error) {
//     await session.abortTransaction();
//     session.endSession();
//     res.status(500).json({ success: false, message: error.message });
//   }
// };
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
    const restoredDoc = await TargetModel.findOneAndUpdate(
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

      const date = new Date(restoredDoc.date);
      date.setHours(0, 0, 0, 0);

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

      // 🔹 Restore stock
      const product = await Product.findById(restoredDoc.product).session(
        session
      );

      if (product) {
        const deductQty =
          (restoredDoc.quantity * restoredDoc.unit.conversionFactor) /
          product.unit.conversionFactor;

        await Product.findByIdAndUpdate(
          product._id,
          { $inc: { quantity: -deductQty } },
          { session }
        );
      }

      // 🔹 Restore payments → account + transaction
      for (const payment of restoredDoc.payments || []) {
        if (!["bank", "mobile-banking", "cash"].includes(payment.method))
          continue;

        const account = await Account.findById(payment.accountId).session(
          session
        );
        if (!account) continue;

        account.balance += payment.amount;
        await account.save({ session });
        await Transaction.create(
          [
            {
              name: `Sale Restore: ${restoredDoc.saleId}`,
              accountId: payment.accountId,
              date: new Date(),
              description: `Restored Sale: ${restoredDoc.saleId}`,
              transactionType: "Income",
              amount: payment.amount,
              source: "Auto",
              category: "Sales Restore",
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

      const today = new Date();
      today.setHours(0, 0, 0, 0);

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
                date: new Date(),
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
    next(new ApiError(500, "Failed to delete trash item"));
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
      originalDoc: originalDoc || null,
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
