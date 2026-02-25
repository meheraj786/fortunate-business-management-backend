const mongoose = require("mongoose");
const mongoosePaginate = require("mongoose-paginate-v2");

const refundSchema = new mongoose.Schema({
    amount: { type: Number, required: true, min: 0 },
    date: { type: Date, required: true },
    accountId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Account",
        required: true,
    },
    paymentMethod: {
        type: String,
        required: true,
        enum: ["Cash", "Bank", "Mobile Banking"],
    },
    transactionId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Transaction",
    },
    note: { type: String, trim: true },
});

const advancePaymentSchema = new mongoose.Schema(
    {
        advanceId: { type: String, required: true, unique: true, trim: true },
        supplierName: { type: String, required: true, trim: true },
        supplierPhone: { type: String, trim: true },
        purpose: { type: String, trim: true },

        amount: { type: Number, required: true, min: 0 },
        accountId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Account",
            required: true,
        },
        paymentMethod: {
            type: String,
            required: true,
            enum: ["Cash", "Bank", "Mobile Banking"],
        },
        date: { type: Date, required: true },

        status: {
            type: String,
            required: true,
            enum: ["Pending", "Settled", "Refunded", "Partially Settled"],
            default: "Pending",
        },
        settledDate: { type: Date, default: null },

        refunds: [refundSchema],

        transactionId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Transaction",
        },

        notes: { type: String, trim: true },
        isDeleted: { type: Boolean, default: false, index: true },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null,
        },
        modifiedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null,
        },
        deletedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null,
        },
    },
    { timestamps: true },
);

advancePaymentSchema.plugin(mongoosePaginate);

// Virtual: computed refunded amount
advancePaymentSchema.virtual("refundedAmount").get(function () {
    return (this.refunds || []).reduce((sum, r) => sum + (r.amount || 0), 0);
});

// Virtual: remaining amount
advancePaymentSchema.virtual("remainingAmount").get(function () {
    const refunded = (this.refunds || []).reduce(
        (sum, r) => sum + (r.amount || 0),
        0,
    );
    return this.amount - refunded;
});

// Ensure virtuals are included in JSON and Object output
advancePaymentSchema.set("toJSON", { virtuals: true });
advancePaymentSchema.set("toObject", { virtuals: true });

// Soft delete filter
advancePaymentSchema.pre(/^find/, function (next) {
    const query = this.getQuery();
    if (query.isDeleted !== undefined) {
        return next();
    }
    this.where({ isDeleted: { $ne: true } });
    next();
});

// Indexes
advancePaymentSchema.index({ isDeleted: 1, date: -1 });
advancePaymentSchema.index({ isDeleted: 1, status: 1 });
advancePaymentSchema.index({ supplierName: 1 });
advancePaymentSchema.index({ date: -1 });

const AdvancePayment = mongoose.model("AdvancePayment", advancePaymentSchema);
module.exports = AdvancePayment;
