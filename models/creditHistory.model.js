const mongoose = require("mongoose");

const creditHistorySchema = new mongoose.Schema(
    {
        customer: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Customer",
            required: true,
        },
        amount: {
            type: Number,
            required: true,
        },
        type: {
            type: String,
            enum: ["Credit", "Debit"], // Credit = In (Deposit, Overpayment), Debit = Out (Purchase)
            required: true,
        },
        reason: {
            type: String,
            enum: ["Overpayment", "Manual Deposit", "Purchase", "Refund", "Sale Cancelled", "Sale Deleted"],
            required: true,
        },
        reference: {
            type: mongoose.Schema.Types.ObjectId,
            refPath: "referenceModel",
        },
        referenceModel: {
            type: String,
            enum: ["Sale", "Transaction"],
        },
        description: {
            type: String,
            trim: true,
        },
        date: {
            type: Date,
            default: Date.now,
        },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null,
        },
    },
    { timestamps: true },
);

// Indexes
creditHistorySchema.index({ customer: 1, date: -1 });

module.exports = mongoose.model("CreditHistory", creditHistorySchema);
