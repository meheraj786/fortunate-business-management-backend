const express = require("express");
const {
  openDailyCash,
  addIncome,
  addExpense,
  closeDailyCash,
  updateTransaction,
  toggleDailyCashStatus,
  getTransactionsByDateRange,
  getDailyCash,
} = require("../../controllers/dailyCash.controller");
const dailyCashRouter = express.Router();

dailyCashRouter.post("/open", openDailyCash);
dailyCashRouter.post("/income", addIncome);
dailyCashRouter.post("/expense", addExpense);
dailyCashRouter.post("/close", closeDailyCash);
dailyCashRouter.put("/update/:date", updateTransaction);
dailyCashRouter.patch("/toggle-status", toggleDailyCashStatus);
dailyCashRouter.get("/filter", getTransactionsByDateRange);
dailyCashRouter.get("/get-cash", getDailyCash);

module.exports = dailyCashRouter;
