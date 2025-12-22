const express = require("express");
const {
  openCash,
  closeCash,
  getDailyCashStatus,
  getDailyCashSummary,
  addIncome,
  addExpense,
} = require("../../controllers/dailyCash.controller");
const { authenticate } = require("../../middleware/auth.middleware");
const authorize = require("../../middleware/authorize.middleware");

const dailyCashRouter = express.Router();

// All routes are protected and require authentication
dailyCashRouter.use(authenticate);

// Routes for managing daily cash status
dailyCashRouter.post("/open", authorize("DAILY_CASH", "CREATE"), openCash);
dailyCashRouter.post("/close", authorize("DAILY_CASH", "UPDATE"), closeCash);
dailyCashRouter.get("/status", authorize("DAILY_CASH", "GET"), getDailyCashStatus);
dailyCashRouter.get("/summary", authorize("DAILY_CASH", "GET"), getDailyCashSummary);

// Routes for adding manual transactions
dailyCashRouter.post("/income", authorize("TRANSACTION", "CREATE"), addIncome);
dailyCashRouter.post("/expense", authorize("TRANSACTION", "CREATE"), addExpense);

module.exports = dailyCashRouter;