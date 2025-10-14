const mongoose = require("mongoose");

const expenseSchema = new mongoose.Schema(
  {
    date: { type: Date, required: true },
    time: { type: String, required: true },
    category: {
      type: String,
      required: true,
    },
    description: { type: String, trim: true },
    amount: { type: Number, required: true, min: 0 },
    paymentMethod: {
      type: String,
      required: true,
    },
    icon: { type: String, trim: true },
  },
  { timestamps: true }
);

expenseSchema.index({ date: 1 });
expenseSchema.index({ category: 1 });

const Expense = mongoose.model("Expense", expenseSchema);
module.exports = Expense;
