const mongoose = require("mongoose");
const AdvancePayment = require("../models/advancePayment.model");
const Account = require("../models/account.model");
const Transaction = require("../models/transaction.model");
const DailyCash = require("../models/dailyCash.model");
const Counter = require("../models/counter.model");
const Trash = require("../models/trash.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const logger = require("../utils/logger");
const { startOfDay, now } = require("../utils/timezone.util");
const { formatAccountLabel } = require("../utils/format.util");
const mathUtil = require("../utils/math.util");
const auditService = require("../services/audit.service");

// ============================================================
// CREATE ADVANCE PAYMENT
// ============================================================
async function createAdvancePayment(req, res, next) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const {
            supplierName,
            supplierPhone,
            purpose,
            amount,
            accountId,
            paymentMethod,
            date,
            notes,
        } = req.body;

        // --- Validation ---
        if (!supplierName || !amount || !accountId || !paymentMethod || !date) {
            throw new ApiError(
                400,
                "Supplier name, amount, account, payment method, and date are required.",
            );
        }
        if (amount <= 0) {
            throw new ApiError(400, "Amount must be greater than zero.");
        }

        // --- Daily Cash Gatekeeper ---
        const paymentDate = startOfDay(new Date(date), req.businessTimezone);
        const dailyCash = await DailyCash.findOne({
            date: paymentDate,
            status: "Open",
            isDeleted: false,
        }).session(session);
        if (!dailyCash) {
            throw new ApiError(
                400,
                `Daily cash is closed for ${paymentDate.toDateString()}. Cannot create advance payment.`,
            );
        }

        // --- Account Balance Check ---
        const account = await Account.findById(accountId).session(session);
        if (!account) {
            throw new ApiError(404, "Account not found.");
        }
        if (account.balance < amount) {
            throw new ApiError(
                400,
                `Insufficient balance in account '${account.accountName}'. Available: ${account.balance}, Required: ${amount}.`,
            );
        }

        // --- Generate Advance ID ---
        const currentYear = new Date().getFullYear();
        const counterId = `advancePaymentId_${currentYear}`;
        let counter = await Counter.findByIdAndUpdate(
            counterId,
            { $inc: { seq: 1 } },
            { new: true, upsert: true },
        ).session(session);

        // Self-healing: check if counter was just created
        if (counter.seq === 1) {
            const lastAdvance = await AdvancePayment.findOne({
                advanceId: new RegExp(`^ADV-${currentYear}-`, "i"),
                isDeleted: { $in: [true, false] },
            })
                .sort({ advanceId: -1 })
                .session(session);

            let maxLegacyId = 0;
            if (lastAdvance && lastAdvance.advanceId) {
                const match = lastAdvance.advanceId.match(/(\d+)$/);
                if (match) {
                    maxLegacyId = parseInt(match[1], 10);
                }
            }
            if (maxLegacyId >= 1) {
                counter = await Counter.findByIdAndUpdate(
                    counterId,
                    { $set: { seq: maxLegacyId + 1 } },
                    { new: true, session },
                );
            }
        }

        const advanceId = `ADV-${currentYear}-${counter.seq.toString().padStart(4, "0")}`;

        // --- Deduct from Account ---
        account.balance = mathUtil.sub(account.balance, amount);
        await account.save({ session });

        // --- Create Transaction ---
        const [transaction] = await Transaction.create(
            [
                {
                    accountId,
                    date,
                    description: `Advance Payment to ${supplierName}${purpose ? ` for ${purpose}` : ""} via ${paymentMethod} Account: ${formatAccountLabel(account)}.`,
                    transactionType: "Expense",
                    amount,
                    name: `Advance Payment: ${supplierName}`,
                    source: "Auto",
                    category: "Advance Payment",
                    paymentMethod,
                    reference: null, // Will be set after advance is created
                    referenceModel: "AdvancePayment",
                    createdBy: req.user?._id || null,
                },
            ],
            { session },
        );

        // --- Create Advance Payment ---
        const [advancePayment] = await AdvancePayment.create(
            [
                {
                    advanceId,
                    supplierName,
                    supplierPhone,
                    purpose,
                    amount,
                    accountId,
                    paymentMethod,
                    date,
                    status: "Pending",
                    refunds: [],
                    transactionId: transaction._id,
                    notes,
                    createdBy: req.user?._id || null,
                },
            ],
            { session },
        );

        // Update transaction with advance payment reference
        transaction.reference = advancePayment._id;
        await transaction.save({ session });

        await session.commitTransaction();
        session.endSession();

        // Audit
        auditService.log({
            action: "CREATE",
            module: "AdvancePayment",
            documentId: advancePayment._id,
            displayId: advanceId,
            userId: req.user?._id,
            description: `Created advance payment ${advanceId} of ${amount} to ${supplierName}`,
            req,
        });

        return res
            .status(201)
            .json(
                new ApiResponse(
                    201,
                    advancePayment,
                    "Advance payment created successfully.",
                ),
            );
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        if (error instanceof ApiError) return next(error);
        logger.error("CreateAdvancePayment Error:", error);
        next(
            new ApiError(
                500,
                "Failed to create advance payment. Please try again.",
            ),
        );
    }
}

// ============================================================
// GET ALL ADVANCE PAYMENTS (Paginated)
// ============================================================
async function getAllAdvancePayments(req, res, next) {
    try {
        const {
            page = 1,
            limit = 10,
            search,
            status,
            startDate,
            endDate,
            sortBy = "date",
            sortOrder = "desc",
        } = req.query;

        const filter = { isDeleted: { $ne: true } };

        if (status) {
            filter.status = status;
        }
        if (search) {
            const searchRegex = { $regex: search, $options: "i" };
            filter.$or = [
                { supplierName: searchRegex },
                { advanceId: searchRegex },
                { purpose: searchRegex },
            ];
        }
        if (startDate || endDate) {
            filter.date = {};
            if (startDate) filter.date.$gte = new Date(startDate);
            if (endDate) filter.date.$lte = new Date(endDate);
        }

        const sortOrderNum = sortOrder === "asc" ? 1 : -1;
        const options = {
            page: parseInt(page, 10),
            limit: parseInt(limit, 10),
            sort: { [sortBy]: sortOrderNum },
            populate: [
                { path: "accountId", select: "accountName accountType bankName serviceName mobileNumber" },
            ],
            lean: true,
        };

        const result = await AdvancePayment.paginate(filter, options);

        // Manually compute virtuals for lean results
        result.docs = result.docs.map((doc) => {
            const addedAmount = (doc.additions || []).reduce(
                (sum, a) => sum + (a.amount || 0),
                0,
            );
            const refundedAmount = (doc.refunds || []).reduce(
                (sum, r) => sum + (r.amount || 0),
                0,
            );
            const totalAmount = doc.amount + addedAmount;
            return {
                ...doc,
                addedAmount,
                totalAmount,
                refundedAmount,
                remainingAmount: totalAmount - refundedAmount,
            };
        });

        return res
            .status(200)
            .json(new ApiResponse(200, result, "Advance payments fetched successfully."));
    } catch (error) {
        if (error instanceof ApiError) return next(error);
        logger.error("GetAllAdvancePayments Error:", error);
        next(new ApiError(500, "Failed to fetch advance payments."));
    }
}

// ============================================================
// GET ADVANCE PAYMENT BY ID
// ============================================================
async function getAdvancePaymentById(req, res, next) {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            throw new ApiError(400, "Invalid advance payment ID.");
        }

        const advancePayment = await AdvancePayment.findById(id)
            .populate("accountId", "accountName accountType bankName serviceName mobileNumber accountNumber")
            .populate("refunds.accountId", "accountName accountType bankName serviceName mobileNumber")
            .populate("additions.accountId", "accountName accountType bankName serviceName mobileNumber")
            .populate("createdBy", "name email")
            .populate("modifiedBy", "name email");

        if (!advancePayment) {
            throw new ApiError(404, "Advance payment not found.");
        }

        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    advancePayment,
                    "Advance payment fetched successfully.",
                ),
            );
    } catch (error) {
        if (error instanceof ApiError) return next(error);
        logger.error("GetAdvancePaymentById Error:", error);
        next(new ApiError(500, "Failed to fetch advance payment details."));
    }
}

// ============================================================
// ADD TO ADVANCE PAYMENT (Top Up)
// ============================================================
async function addToAdvancePayment(req, res, next) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const { id } = req.params;
        const { amount: addAmount, accountId, paymentMethod, date, note } = req.body;

        // --- Validation ---
        if (!addAmount || !accountId || !paymentMethod || !date) {
            throw new ApiError(
                400,
                "Amount, account, payment method, and date are required.",
            );
        }
        if (addAmount <= 0) {
            throw new ApiError(400, "Amount must be greater than zero.");
        }

        const advancePayment = await AdvancePayment.findById(id).session(session);
        if (!advancePayment) {
            throw new ApiError(404, "Advance payment not found.");
        }
        if (advancePayment.status === "Settled" || advancePayment.status === "Refunded") {
            throw new ApiError(
                400,
                `This advance payment is already ${advancePayment.status.toLowerCase()}. Cannot add more funds.`,
            );
        }

        // --- Daily Cash Gatekeeper ---
        const addDate = startOfDay(new Date(date), req.businessTimezone);
        const dailyCash = await DailyCash.findOne({
            date: addDate,
            status: "Open",
            isDeleted: false,
        }).session(session);
        if (!dailyCash) {
            throw new ApiError(
                400,
                `Daily cash is closed for ${addDate.toDateString()}. Cannot add to advance payment.`,
            );
        }

        // --- Account Balance Check ---
        const account = await Account.findById(accountId).session(session);
        if (!account) {
            throw new ApiError(404, "Account not found.");
        }
        if (account.balance < addAmount) {
            throw new ApiError(
                400,
                `Insufficient balance in account '${account.accountName}'. Available: ${account.balance}, Required: ${addAmount}.`,
            );
        }

        // --- Deduct from Account ---
        account.balance = mathUtil.sub(account.balance, addAmount);
        await account.save({ session });

        // --- Create Transaction ---
        const [transaction] = await Transaction.create(
            [
                {
                    accountId,
                    date,
                    description: `Additional Advance Payment to ${advancePayment.supplierName} (${advancePayment.advanceId}) via ${paymentMethod} Account: ${formatAccountLabel(account)}.`,
                    transactionType: "Expense",
                    amount: addAmount,
                    name: `Advance Top-Up: ${advancePayment.supplierName}`,
                    source: "Auto",
                    category: "Advance Payment",
                    paymentMethod,
                    reference: advancePayment._id,
                    referenceModel: "AdvancePayment",
                    createdBy: req.user?._id || null,
                },
            ],
            { session },
        );

        // --- Update Advance Payment ---
        advancePayment.additions.push({
            amount: addAmount,
            date,
            accountId,
            paymentMethod,
            transactionId: transaction._id,
            note,
        });

        // If it was Partially Settled, keep it. Otherwise keep Pending.
        if (advancePayment.status !== "Partially Settled") {
            advancePayment.status = "Pending";
        }
        advancePayment.modifiedBy = req.user?._id || null;
        await advancePayment.save({ session });

        await session.commitTransaction();
        session.endSession();

        // Audit
        auditService.log({
            action: "UPDATE",
            module: "AdvancePayment",
            documentId: advancePayment._id,
            displayId: advancePayment.advanceId,
            userId: req.user?._id,
            description: `Added ${addAmount} to advance payment ${advancePayment.advanceId} (${advancePayment.supplierName})`,
            req,
        });

        return res
            .status(200)
            .json(
                new ApiResponse(200, advancePayment, "Amount added to advance payment successfully."),
            );
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        if (error instanceof ApiError) return next(error);
        logger.error("AddToAdvancePayment Error:", error);
        next(new ApiError(500, "Failed to add to advance payment. Please try again."));
    }
}

// ============================================================
// SETTLE ADVANCE PAYMENT
// ============================================================
async function settleAdvancePayment(req, res, next) {
    try {
        const { id } = req.params;
        const { settledDate } = req.body;

        const advancePayment = await AdvancePayment.findById(id);
        if (!advancePayment) {
            throw new ApiError(404, "Advance payment not found.");
        }

        if (advancePayment.status === "Settled" || advancePayment.status === "Refunded") {
            throw new ApiError(
                400,
                `This advance payment is already ${advancePayment.status.toLowerCase()}.`,
            );
        }

        advancePayment.status = "Settled";
        advancePayment.settledDate = settledDate || now();
        advancePayment.modifiedBy = req.user?._id || null;
        await advancePayment.save();

        // Audit
        auditService.log({
            action: "UPDATE",
            module: "AdvancePayment",
            documentId: advancePayment._id,
            displayId: advancePayment.advanceId,
            userId: req.user?._id,
            description: `Settled advance payment ${advancePayment.advanceId} to ${advancePayment.supplierName}`,
            req,
        });

        return res
            .status(200)
            .json(
                new ApiResponse(200, advancePayment, "Advance payment settled successfully."),
            );
    } catch (error) {
        if (error instanceof ApiError) return next(error);
        logger.error("SettleAdvancePayment Error:", error);
        next(new ApiError(500, "Failed to settle advance payment."));
    }
}

// ============================================================
// REFUND ADVANCE PAYMENT
// ============================================================
async function refundAdvancePayment(req, res, next) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const { id } = req.params;
        const { amount: refundAmount, accountId, paymentMethod, date, note } = req.body;

        // --- Validation ---
        if (!refundAmount || !accountId || !paymentMethod || !date) {
            throw new ApiError(
                400,
                "Refund amount, account, payment method, and date are required.",
            );
        }
        if (refundAmount <= 0) {
            throw new ApiError(400, "Refund amount must be greater than zero.");
        }

        const advancePayment = await AdvancePayment.findById(id).session(session);
        if (!advancePayment) {
            throw new ApiError(404, "Advance payment not found.");
        }
        if (advancePayment.status === "Settled" || advancePayment.status === "Refunded") {
            throw new ApiError(
                400,
                `This advance payment is already ${advancePayment.status.toLowerCase()}. Cannot refund.`,
            );
        }

        // Calculate remaining amount (including additions)
        const addedSoFar = (advancePayment.additions || []).reduce(
            (sum, a) => mathUtil.add(sum, a.amount || 0),
            0,
        );
        const totalEffective = mathUtil.add(advancePayment.amount, addedSoFar);
        const refundedSoFar = (advancePayment.refunds || []).reduce(
            (sum, r) => mathUtil.add(sum, r.amount || 0),
            0,
        );
        const remaining = mathUtil.sub(totalEffective, refundedSoFar);

        if (refundAmount > remaining + 0.001) {
            throw new ApiError(
                400,
                `Refund amount (${refundAmount}) exceeds the remaining advance amount (${remaining}).`,
            );
        }

        // --- Daily Cash Gatekeeper ---
        const refundDate = startOfDay(new Date(date), req.businessTimezone);
        const dailyCash = await DailyCash.findOne({
            date: refundDate,
            status: "Open",
            isDeleted: false,
        }).session(session);
        if (!dailyCash) {
            throw new ApiError(
                400,
                `Daily cash is closed for ${refundDate.toDateString()}. Cannot process refund.`,
            );
        }

        // --- Credit Account ---
        const account = await Account.findById(accountId).session(session);
        if (!account) {
            throw new ApiError(404, "Refund account not found.");
        }
        account.balance = mathUtil.add(account.balance, refundAmount);
        await account.save({ session });

        // --- Create Refund Transaction ---
        const [refundTransaction] = await Transaction.create(
            [
                {
                    accountId,
                    date,
                    description: `Advance Payment Refund from ${advancePayment.supplierName} (${advancePayment.advanceId}) via ${paymentMethod} Account: ${formatAccountLabel(account)}.`,
                    transactionType: "Income",
                    amount: refundAmount,
                    name: `Advance Refund: ${advancePayment.supplierName}`,
                    source: "Auto",
                    category: "Advance Payment",
                    paymentMethod,
                    reference: advancePayment._id,
                    referenceModel: "AdvancePayment",
                    createdBy: req.user?._id || null,
                },
            ],
            { session },
        );

        // --- Update Advance Payment ---
        advancePayment.refunds.push({
            amount: refundAmount,
            date,
            accountId,
            paymentMethod,
            transactionId: refundTransaction._id,
            note,
        });

        const newRefundedTotal = mathUtil.add(refundedSoFar, refundAmount);
        // Determine new status
        if (mathUtil.sub(totalEffective, newRefundedTotal) <= 0.001) {
            advancePayment.status = "Refunded";
            advancePayment.settledDate = now();
        } else {
            advancePayment.status = "Partially Settled";
        }
        advancePayment.modifiedBy = req.user?._id || null;
        await advancePayment.save({ session });

        await session.commitTransaction();
        session.endSession();

        // Audit
        auditService.log({
            action: "PAYMENT",
            module: "AdvancePayment",
            documentId: advancePayment._id,
            displayId: advancePayment.advanceId,
            userId: req.user?._id,
            description: `Refunded ${refundAmount} from advance payment ${advancePayment.advanceId} (${advancePayment.supplierName})`,
            req,
        });

        return res
            .status(200)
            .json(
                new ApiResponse(200, advancePayment, "Refund processed successfully."),
            );
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        if (error instanceof ApiError) return next(error);
        logger.error("RefundAdvancePayment Error:", error);
        next(new ApiError(500, "Failed to process refund. Please try again."));
    }
}

// ============================================================
// DELETE ADVANCE PAYMENT (Same-day only)
// ============================================================
async function deleteAdvancePayment(req, res, next) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const { id } = req.params;

        const advancePayment = await AdvancePayment.findById(id).session(session);
        if (!advancePayment) {
            throw new ApiError(404, "Advance payment not found.");
        }
        if (advancePayment.isDeleted) {
            throw new ApiError(400, "Advance payment is already in the trash.");
        }

        // --- Same-day check ---
        const today = startOfDay(now(), req.businessTimezone);
        const advanceDate = startOfDay(
            new Date(advancePayment.date),
            req.businessTimezone,
        );

        if (today.getTime() !== advanceDate.getTime()) {
            throw new ApiError(
                400,
                "Advance payments can only be deleted on the same day they were created. Use Settle or Refund instead.",
            );
        }

        // --- Daily Cash Gatekeeper ---
        const dailyCash = await DailyCash.findOne({
            date: today,
            status: "Open",
            isDeleted: false,
        }).session(session);
        if (!dailyCash) {
            throw new ApiError(
                400,
                `Daily cash is closed for ${today.toDateString()}. Cannot delete advance payment.`,
            );
        }

        // --- Reverse original expense: return money to account ---
        const originalAccount = await Account.findById(
            advancePayment.accountId,
        ).session(session);
        if (originalAccount) {
            originalAccount.balance = mathUtil.add(
                originalAccount.balance,
                advancePayment.amount,
            );
            await originalAccount.save({ session });
        }

        // --- Hard-delete the original expense transaction ---
        if (advancePayment.transactionId) {
            await Transaction.deleteOne(
                { _id: advancePayment.transactionId },
            ).session(session);
        }

        // --- Reverse and hard-delete all refund transactions ---
        for (const refund of advancePayment.refunds || []) {
            // Deduct refund amount from the refund account
            const refundAccount = await Account.findById(refund.accountId).session(
                session,
            );
            if (refundAccount) {
                if (refundAccount.balance < refund.amount) {
                    throw new ApiError(
                        400,
                        `Insufficient balance in account '${refundAccount.accountName}' to reverse refund of ${refund.amount}.`,
                    );
                }
                refundAccount.balance = mathUtil.sub(
                    refundAccount.balance,
                    refund.amount,
                );
                await refundAccount.save({ session });
            }
            // Hard-delete the refund transaction
            if (refund.transactionId) {
                await Transaction.deleteOne(
                    { _id: refund.transactionId },
                ).session(session);
            }
        }

        // --- Reverse and hard-delete all addition (top-up) transactions ---
        for (const addition of advancePayment.additions || []) {
            // Return addition amount to the source account
            const addAccount = await Account.findById(addition.accountId).session(
                session,
            );
            if (addAccount) {
                addAccount.balance = mathUtil.add(
                    addAccount.balance,
                    addition.amount,
                );
                await addAccount.save({ session });
            }
            // Hard-delete the addition transaction
            if (addition.transactionId) {
                await Transaction.deleteOne(
                    { _id: addition.transactionId },
                ).session(session);
            }
        }

        // --- Soft-delete advance payment → Trash ---
        advancePayment.isDeleted = true;
        advancePayment.deletedBy = req.user?._id || null;
        await advancePayment.save({ session });

        await Trash.create(
            [
                {
                    docId: advancePayment._id,
                    model: "AdvancePayment",
                    deletedBy: req.user?._id || null,
                    deletedAt: now(),
                },
            ],
            { session },
        );

        await session.commitTransaction();
        session.endSession();

        // Audit
        auditService.log({
            action: "DELETE",
            module: "AdvancePayment",
            documentId: advancePayment._id,
            displayId: advancePayment.advanceId,
            userId: req.user?._id,
            description: `Deleted advance payment ${advancePayment.advanceId} (${advancePayment.supplierName}, ${advancePayment.amount})`,
            req,
        });

        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    null,
                    "Advance payment moved to trash successfully.",
                ),
            );
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        if (error instanceof ApiError) return next(error);
        logger.error("DeleteAdvancePayment Error:", error);
        next(
            new ApiError(
                500,
                "Failed to delete advance payment. Please try again.",
            ),
        );
    }
}

// ============================================================
// GET ADVANCE PAYMENT STATS
// ============================================================
async function getAdvancePaymentStats(req, res, next) {
    try {
        const stats = await AdvancePayment.aggregate([
            { $match: { isDeleted: { $ne: true } } },
            {
                $group: {
                    _id: "$status",
                    count: { $sum: 1 },
                    totalAmount: { $sum: "$amount" },
                },
            },
        ]);

        const totalPendingAmount = await AdvancePayment.aggregate([
            { $match: { isDeleted: { $ne: true }, status: "Pending" } },
            {
                $group: {
                    _id: null,
                    total: { $sum: "$amount" },
                },
            },
        ]);

        const result = {
            byStatus: stats.reduce(
                (acc, s) => {
                    acc[s._id] = { count: s.count, totalAmount: s.totalAmount };
                    return acc;
                },
                {},
            ),
            totalPendingAmount: totalPendingAmount[0]?.total || 0,
            totalCount: stats.reduce((sum, s) => sum + s.count, 0),
        };

        return res
            .status(200)
            .json(new ApiResponse(200, result, "Stats fetched successfully."));
    } catch (error) {
        if (error instanceof ApiError) return next(error);
        logger.error("GetAdvancePaymentStats Error:", error);
        next(new ApiError(500, "Failed to fetch advance payment stats."));
    }
}

module.exports = {
    createAdvancePayment,
    getAllAdvancePayments,
    getAdvancePaymentById,
    addToAdvancePayment,
    settleAdvancePayment,
    refundAdvancePayment,
    deleteAdvancePayment,
    getAdvancePaymentStats,
};
