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
    incomeList: [
      {
        category: {
          type: string,
          required: true,
        },
        description: {
          type: string,
        },
        amount: {
          type: number,
          required: true,
        },
        time: {
          type: string,
          required: true,
        },
      },
    ],
    expenseList: [
      {
        category: {
          type: string,
          required: true,
        },
        description: {
          type: string,
        },
        amount: {
          type: number,
          required: true,
        },
        time: {
          type: string,
          required: true,
        },
      },
    ],
    lcId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lc",
    },
    sales: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Sales",
    },
    isClosed: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

const DailyCash = mongoose.model("DailyCash", dailyCashSchema);
module.exports = DailyCash;
