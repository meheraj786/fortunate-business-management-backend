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
const authorize = require("../../middleware/authorize.middleware");
const { authenticate } = require("../../middleware/auth.middleware");
const dailyCashRouter = express.Router();

dailyCashRouter.post("/open", authenticate, authorize("DAILY_CASH", "CREATE"), openDailyCash);
dailyCashRouter.post("/income", authenticate, authorize("DAILY_CASH", "CREATE"), addIncome);
dailyCashRouter.post("/expense", authenticate, authorize("DAILY_CASH", "CREATE"), addExpense);
dailyCashRouter.post("/close", authenticate, authorize("DAILY_CASH", "CREATE"), closeDailyCash);
dailyCashRouter.put("/update/:date", authenticate, authorize("DAILY_CASH", "UPDATE"), updateTransaction);
dailyCashRouter.patch("/toggle-status", authenticate, authorize("DAILY_CASH", "UPDATE"), toggleDailyCashStatus);
dailyCashRouter.get("/filter",  getTransactionsByDateRange);
dailyCashRouter.get("/get-cash", authenticate, authorize("DAILY_CASH", "GET"), getDailyCash);

module.exports = dailyCashRouter;
