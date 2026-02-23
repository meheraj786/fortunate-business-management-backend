// Import mongoose for database session and model handling
const mongoose = require("mongoose");

// Import Trash model
const Trash = require("../models/trash.model");

// Import response helpers
const { ApiResponse } = require("../utils/ApiResponse");
const { ApiError } = require("../utils/ApiError");

// Import logger
const logger = require("../utils/logger");

// Import timezone helpers
const { startOfDay, now } = require("../utils/timezone.util"); // Import startOfDay
const { formatAccountLabel } = require("../utils/format.util");
const mathUtil = require("../utils/math.util");

// ===============================
// MOVE DOCUMENT TO TRASH
// ===============================
const moveToTrash = async ({ docId, modelName, deletedBy = null, session = null }) => {
  // Validate required data
  if (!docId || !modelName) {
    throw new Error(
      "Document ID and module name are required to move item to trash.",
    );
  }

  // Build query options (support optional session for transactional safety)
  const options = { upsert: true, new: true };
  if (session) options.session = session;

  // Create or update trash entry
  await Trash.findOneAndUpdate(
    { docId, model: modelName },
    {
      docId,
      model: modelName,
      deletedBy,
      deletedAt: now(),
    },
    options,
  );
};

// ===============================
// RESTORE ITEM FROM TRASH
// ===============================
const restoreFromTrash = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { id } = req.params;

    // 1️⃣ Find trash record
    const trashEntry = await Trash.findById(id).session(session);
    if (!trashEntry) {
      throw new ApiError(
        404,
        "This trash item could not be found. It may have already been removed.",
      );
    }

    const { docId, model: modelName } = trashEntry;
    const TargetModel = mongoose.model(modelName);

    // 2️⃣ Restore main document
    let restoredDoc = await TargetModel.findOneAndUpdate(
      { _id: docId, isDeleted: true },
      { $set: { isDeleted: false, status: "Active" } },
      { session, new: true },
    );

    if (!restoredDoc) {
      throw new ApiError(
        404,
        `The ${modelName} record could not be restored because it no longer exists.`,
      );
    }

    /* =====================================================
        TRANSACTION RESTORE
    ===================================================== */
    if (modelName === "Transaction") {
      const Account = mongoose.model("Account");
      const DailyCash = mongoose.model("DailyCash");

      const date = startOfDay(new Date(restoredDoc.date), req.businessTimezone);

      const dailyCash = await DailyCash.findOne({
        date,
        status: "Open",
      }).session(session);

      if (!dailyCash) {
        throw new ApiError(
          400,
          `Daily cash is closed for ${date.toDateString()}. Transaction restore is not allowed.`,
        );
      }

      const account = await Account.findById(restoredDoc.accountId).session(
        session,
      );
      if (!account) {
        throw new ApiError(
          404,
          "The linked account for this transaction was not found.",
        );
      }

      if (restoredDoc.transactionType === "Income") {
        account.balance = mathUtil.add(account.balance, restoredDoc.amount);
      } else {
        if (account.balance < restoredDoc.amount) {
          throw new ApiError(
            400,
            "The account does not have enough balance to restore this expense transaction.",
          );
        }
        account.balance = mathUtil.sub(account.balance, restoredDoc.amount);
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
      const Customer = mongoose.model("Customer");
      const CreditHistory = mongoose.model("CreditHistory");

      // Re-fetch sale with required relations
      const saleToRestore = await TargetModel.findById(docId)
        .populate({ path: "unit", strictPopulate: false })
        .populate({ path: "product", strictPopulate: false, populate: { path: "unit", strictPopulate: false } })
        .populate({ path: "items.unit", strictPopulate: false })
        .populate({ path: "items.product", strictPopulate: false, populate: { path: "unit", strictPopulate: false } })
        .session(session);

      if (!saleToRestore) {
        throw new ApiError(
          404,
          "The original sale record could not be found for restoration.",
        );
      }

      // 🔹 Restore stock
      // 🔹 Restore stock
      // 1. Multi-item Sales
      if (saleToRestore.items && saleToRestore.items.length > 0) {
        for (const item of saleToRestore.items) {
          const product = item.product;
          const saleUnit = item.unit;

          if (product && saleUnit && product.unit) {
            if (product.unit.type !== saleUnit.type) {
              // Log error but maybe continue? or throw? Throwing protects data integrity.
              throw new ApiError(400, `Stock restoration failed: Unit mismatch for product ${product.name}`);
            }

            const deductQty =
              (item.quantity * saleUnit.conversionFactor) /
              product.unit.conversionFactor;

            if (product.quantity < deductQty) {
              throw new ApiError(400, `Not enough stock available to restore ${product.name}. Required: ${deductQty}, Available: ${product.quantity}`);
            }

            await Product.findByIdAndUpdate(
              product._id,
              { $inc: { quantity: -deductQty } },
              { session }
            );
          }
        }
      }
      // 2. Legacy Single-item Sales
      else if (saleToRestore.product && saleToRestore.unit) {
        const product = saleToRestore.product;
        // Check if product exists and units are populated
        if (product && product.unit && saleToRestore.unit) {
          if (product.unit.type !== saleToRestore.unit.type) {
            throw new ApiError(
              400,
              "Stock restoration failed because product unit and sale unit do not match.",
            );
          }

          const deductQty =
            (saleToRestore.quantity * saleToRestore.unit.conversionFactor) /
            product.unit.conversionFactor;

          if (product.quantity < deductQty) {
            throw new ApiError(
              400,
              "Not enough stock available to restore this sale.",
            );
          }

          await Product.findByIdAndUpdate(
            product._id,
            { $inc: { quantity: -deductQty } },
            { session },
          );
        }
      }

      // Update sale status
      saleToRestore.isDeleted = false;
      saleToRestore.status = "Active";
      restoredDoc = await saleToRestore.save({ session });

      // Check Daily Cash before restoring payments
      if (restoredDoc.payments.length > 0) {
        const DailyCash = mongoose.model("DailyCash");
        const today = startOfDay(now(), req.businessTimezone);

        const dailyCash = await DailyCash.findOne({
          date: today,
          status: "Open",
        }).session(session);

        if (!dailyCash) {
          throw new ApiError(
            400,
            `Daily cash is closed for ${today.toDateString()}. Sale payment restoration is not allowed.`,
          );
        }
      }

      // 🔹 Restore payments
      const totalPayments = (restoredDoc.payments || []).length;
      for (const [index, payment] of (restoredDoc.payments || []).entries()) {
        // Handle Real Money (Cash/Bank)
        if (["Bank", "Mobile Banking", "Cash"].includes(payment.method)) {
          const account = await Account.findById(payment.accountId).session(
            session,
          );
          if (!account) continue;

          account.balance = mathUtil.add(account.balance, payment.amount);
          await account.save({ session });

          await Transaction.create(
            [
              {
                name: `Sale Payment Restored (Sale ID: ${restoredDoc.saleId})`,
                accountId: payment.accountId,
                date: now(),
                description: `Restored from Trash - Payment for Sale ID: ${restoredDoc.saleId} (Customer: ${restoredDoc.customer?.name}) via ${payment.method} (Payment ${index + 1} of ${totalPayments}). Account: ${formatAccountLabel(account)}`,
                transactionType: "Income",
                amount: payment.amount,
                source: "Auto",
                category: "Sale Restoration",
                paymentMethod: payment.method,
                reference: restoredDoc._id,
                referenceModel: "Sale",
                miscReference: {
                  saleId: restoredDoc.saleId,
                  customerName: restoredDoc.customer?.name,
                  paymentId: payment._id,
                  paymentIndex: index,
                },
              },
            ],
            { session },
          );
        }
        // Handle Customer Credit
        else if (payment.method === "Customer Credit") {
          const customerId = restoredDoc.customer?.customerId;
          if (!customerId) {
            // Should not happen for credit sales, but safe guard
            throw new ApiError(400, "Cannot restore credit payment: Customer not found on sale.");
          }

          const customer = await Customer.findById(customerId).session(session);
          if (!customer) {
            throw new ApiError(404, "Customer not found for credit restoration.");
          }

          // Check if they have enough balance to "pay" again
          // Restoration means we are taking money FROM them (Debit) because the sale is active again.
          if (customer.creditBalance < payment.amount) {
            throw new ApiError(
              400,
              `Customer does not have enough credit balance to restore this sale. Required: ${payment.amount}, Available: ${customer.creditBalance}`
            );
          }

          customer.creditBalance = mathUtil.sub(customer.creditBalance, payment.amount);
          await customer.save({ session });

          await CreditHistory.create(
            [
              {
                customer: customerId,
                amount: payment.amount,
                type: "Debit",
                reason: "Purchase Restoration",
                reference: restoredDoc._id,
                referenceModel: "Sale",
                description: `Payment restored for Sale ID: ${restoredDoc.saleId} (Payment ${index + 1} of ${totalPayments})`,
                createdBy: req.user?._id, // Assuming req.user is populated in middleware
              },
            ],
            { session }
          );
        }
      }
    }

    /* =====================================================
        LC RESTORE
    ===================================================== */
    if (modelName === "LC") {
      const Account = mongoose.model("Account");
      const Transaction = mongoose.model("Transaction");
      const DailyCash = mongoose.model("DailyCash");

      const today = startOfDay(now(), req.businessTimezone);

      const dailyCash = await DailyCash.findOne({
        date: today,
        status: "Open",
      }).session(session);

      if (!dailyCash) {
        throw new ApiError(
          400,
          `Daily cash is closed for ${today.toDateString()}. LC cost restoration is not allowed.`,
        );
      }

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
            session,
          );

          if (!account || account.balance < cost.amount) {
            throw new ApiError(
              400,
              `Insufficient account balance to restore LC expense: ${cost.name}.`,
            );
          }

          // Deduct again
          account.balance = mathUtil.sub(account.balance, cost.amount);
          await account.save({ session });

          await Transaction.create(
            [
              {
                name: `LC Cost Restored: ${cost.name}`,
                accountId: cost.accountId,
                date: now(),
                description: `Expense restored for LC number ${restoredDoc.basicInfo.lcNumber}. Cost name: ${cost.name}.`,
                transactionType: "Expense",
                amount: cost.amount,
                source: "Auto",
                category: "LC Restoration",
                paymentMethod: cost.paymentMethod,
                reference: restoredDoc._id,
                referenceModel: "LC",
              },
            ],
            { session },
          );
        }
      }
    }

    // 3️⃣ Remove trash entry
    await Trash.findByIdAndDelete(id).session(session);

    await session.commitTransaction();
    session.endSession();

    res
      .status(200)
      .json(
        new ApiResponse(
          200,
          restoredDoc,
          `${modelName} has been successfully restored and is now active again.`,
        ),
      );
  } catch (error) {
    await session.abortTransaction();
    session.endSession();

    if (error instanceof ApiError) {
      return next(error);
    }

    logger.error(error);
    next(
      new ApiError(
        500,
        "Something went wrong while restoring the item. Please try again later.",
      ),
    );
  }
};

// ===============================
// GET ALL TRASH ITEMS
// ===============================
const getAllTrash = async (req, res, next) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const { model: moduleFilter } = req.params;
    const { warehouseId } = req.query;

    const filter = {};
    if (moduleFilter && moduleFilter !== "undefined" && moduleFilter !== "") {
      filter.model = moduleFilter;
    }

    if (warehouseId) {
      if (
        req.user.roleName !== "SUPER_ADMIN" &&
        !req.user.warehouse.map(String).includes(String(warehouseId))
      ) {
        return next(
          new ApiError(
            403,
            "You do not have permission to view trash items for this warehouse.",
          ),
        );
      }
      filter["metadata.warehouseId"] = new mongoose.Types.ObjectId(warehouseId);
    } else if (req.user.roleName !== "SUPER_ADMIN") {
      const accessibleWarehouseObjectIds = req.user.warehouse.map(
        (id) => new mongoose.Types.ObjectId(id),
      );
      filter["metadata.warehouseId"] = { $in: accessibleWarehouseObjectIds };
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
    next(new ApiError(500, "Failed to load trash items. Please try again."));
  }
};

// ===============================
// PERMANENT DELETE FROM TRASH
// ===============================
const deleteTrashPermanently = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { id } = req.params;

    const trashEntry = await Trash.findById(id).session(session);
    if (!trashEntry) {
      throw new ApiError(404, "The selected trash item was not found.");
    }

    const { docId, model: modelName } = trashEntry;
    const TargetModel = mongoose.model(modelName);

    const originalDoc = await TargetModel.findByIdAndDelete(docId, { session });
    if (!originalDoc) {
      logger.warn(
        `Original document already missing. Model: ${modelName}, ID: ${docId}`,
      );
    }

    await Trash.findByIdAndDelete(id, { session });

    await session.commitTransaction();
    session.endSession();

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          null,
          "The item has been permanently deleted and cannot be recovered.",
        ),
      );
  } catch (err) {
    await session.abortTransaction();
    session.endSession();

    if (err instanceof ApiError) {
      return next(err);
    }

    logger.error("Permanent delete error:", err);
    next(
      new ApiError(
        500,
        "Failed to permanently delete the item. Please try again.",
      ),
    );
  }
};

// ===============================
// GET TRASH ITEM DETAILS
// ===============================
const getTrashDetailById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const trash = await Trash.findById(id).populate("deletedBy", "name email");
    if (!trash) {
      throw new ApiError(404, "Trash item details could not be found.");
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

    res
      .status(200)
      .json(
        new ApiResponse(
          200,
          response,
          "Trash item details loaded successfully.",
        ),
      );
  } catch (err) {
    logger.error("GetTrashDetailById Error:", err);

    if (err instanceof ApiError) {
      return next(err);
    }

    next(
      new ApiError(500, "Unable to fetch trash item details at this moment."),
    );
  }
};

// Export all handlers
module.exports = {
  moveToTrash,
  restoreFromTrash,
  getAllTrash,
  deleteTrashPermanently,
  getTrashDetailById,
};
