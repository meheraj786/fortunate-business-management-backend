const mongoose = require("mongoose");

const incomeSchema = new mongoose.Schema({
  category: {
    type: String,
    required: true,
  },
  description: {
    type: String,
  },
  amount: {
    type: Number,
    required: true,
  },
  time: {
    type: String,
    required: true,
  },
  lcId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Lc",
  },
  sales: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Sales",
  },
});

const expenseSchema = new mongoose.Schema({
  category: {
    type: String,
    required: true,
  },
  description: {
    type: String,
  },
  amount: {
    type: Number,
    required: true,
  },
  time: {
    type: String,
    required: true,
  },
  lcId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Lc",
  },
  sales: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Sales",
  },
});

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
    incomeList: [incomeSchema],
    expenseList: [expenseSchema],
    isClosed: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

const DailyCash = mongoose.model("DailyCash", dailyCashSchema);
module.exports = DailyCash;
