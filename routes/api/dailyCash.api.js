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
dailyCashRouter.post("/open", authorize("CASH", "CREATE"), openCash);
dailyCashRouter.post("/close", authorize("CASH", "UPDATE"), closeCash);
dailyCashRouter.get("/status", authorize("CASH", "GET"), getDailyCashStatus);
dailyCashRouter.get("/summary", authorize("CASH", "GET"), getDailyCashSummary);

// Routes for adding manual transactions
dailyCashRouter.post("/income", authorize("CASH", "CREATE"), addIncome);
dailyCashRouter.post("/expense", authorize("CASH", "CREATE"), addExpense);

module.exports = dailyCashRouter;