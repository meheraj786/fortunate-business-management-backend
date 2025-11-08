const mongoose = require("mongoose");

const transactionSchema = new mongoose.Schema(
  {
    bankAccount: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BankAccount",
      required: true,
    },
    date: { type: Date, required: true, default: Date.now },
    description: { type: String, required: true, trim: true },
    type: { type: String, enum: ["Credit", "Debit"], required: true },
    amount: { type: Number, required: true, min: 0 },
    source: { type: String, default: "Manual Entry" },
    reference: { type: mongoose.Schema.Types.ObjectId }, // Generic reference for sales, etc.
  },
  { timestamps: true }
);

const Transaction = mongoose.model("Transaction", transactionSchema);
module.exports = Transaction;
