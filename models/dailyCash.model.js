const mongoose = require("mongoose");

const dailyCashSchema = new mongoose.Schema(
  {
    date: {
      type: Date,
      required: true,
      unique: true,
    },
    openingBalance: {
      type: Number,
      required: true,
      default: 0,
    },
    totalIncome: {
      type: Number,
      default: 0,
    },
    totalExpense: {
      type: Number,
      default: 0,
    },
    runningBalance: {
      type: Number,
      default: 0,
    },
    transactions: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Expense", 
      },
    ],
    isClosed: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

const DailyCash = mongoose.model("DailyCash", dailyCashSchema);
module.exports = DailyCash;
