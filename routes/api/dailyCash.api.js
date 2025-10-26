const express = require("express");
const dailyCashRouter = express.Router();
const {
  openDailyCash,
  addIncome,
  addExpense,
  closeDailyCash,
  updateTransaction,
  toggleDailyCashStatus,
  getTransactionsByDateRange,
} = require("../controllers/dailyCash.controller");

dailyCashRouter.post("/open", openDailyCash);
dailyCashRouter.post("/income", addIncome);
dailyCashRouter.post("/expense", addExpense);
dailyCashRouter.post("/close", closeDailyCash);
dailyCashRouter.put("/update/:date", updateTransaction);
dailyCashRouter.patch("/toggle-status", toggleDailyCashStatus);
dailyCashRouter.get("/filter", getTransactionsByDateRange);

module.exports = dailyCashRouter;
