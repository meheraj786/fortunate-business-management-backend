const mongoose = require("mongoose");
const mongoosePaginate = require("mongoose-paginate-v2");

const transactionSchema = new mongoose.Schema(
  {
    accountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      required: true,
    },
    date: {
      type: Date,
      required: true,
    },
    transactionType: {
      type: String,
      enum: ["Income", "Expense"],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    name: {
      type: String,
      trim: true,
      required: true,
    },
    source: {
      type: String,
      enum: ["Manual", "Auto", "Account"],
      required: true,
    },
    paymentMethod: {
      type: String,
      enum: ["Cash", "Bank", "Mobile Banking"],
      required: true,
    },
    description: {
      type: String,
      trim: true,
    },
    category: {
      type: String,
      required: true,
    },
    reference: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: "referenceModel",
    },
    referenceModel: {
      type: String,
      enum: ["Sale", "LC"],
    },
    miscReference: {
      type: mongoose.Schema.Types.Mixed,
    },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  { timestamps: true },
);

transactionSchema.plugin(mongoosePaginate);

// Indexes for performance
transactionSchema.index({ isDeleted: 1, date: -1, accountId: 1 });
transactionSchema.index({ date: -1 });
transactionSchema.index({ accountId: 1 });
transactionSchema.index({ category: 1 });

const Transaction = mongoose.model("Transaction", transactionSchema);

module.exports = Transaction;
