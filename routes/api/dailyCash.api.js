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
const { authMiddleware } = require("../../middleware/auth.middleware");
const dailyCashRouter = express.Router();

dailyCashRouter.post("/open", authMiddleware, authorize("DAILY_CASH", "CREATE"), openDailyCash);
dailyCashRouter.post("/income", authMiddleware, authorize("DAILY_CASH", "CREATE"), addIncome);
dailyCashRouter.post("/expense", authMiddleware, authorize("DAILY_CASH", "CREATE"), addExpense);
dailyCashRouter.post("/close", authMiddleware, authorize("DAILY_CASH", "CREATE"), closeDailyCash);
dailyCashRouter.put("/update/:date", authMiddleware, authorize("DAILY_CASH", "UPDATE"), updateTransaction);
dailyCashRouter.patch("/toggle-status", authMiddleware, authorize("DAILY_CASH", "UPDATE"), toggleDailyCashStatus);
dailyCashRouter.get("/filter",  getTransactionsByDateRange);
dailyCashRouter.get("/get-cash", authMiddleware, authorize("DAILY_CASH", "GET"), getDailyCash);

module.exports = dailyCashRouter;
