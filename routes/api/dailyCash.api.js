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
const { authorize } = require("../../middleware/authorize.middleware");
const { PERMISSIONS } = require("../../utils/permissions.constants");

const dailyCashRouter = express.Router();

// All routes are protected and require authentication
dailyCashRouter.use(authenticate);

// Routes for managing daily cash status
dailyCashRouter.post(
  "/open",
  authorize(PERMISSIONS.CASH_ACCOUNTS_OPEN_CLOSE),
  openCash
);
dailyCashRouter.post(
  "/close",
  authorize(PERMISSIONS.CASH_ACCOUNTS_OPEN_CLOSE),
  closeCash
);
dailyCashRouter.get("/status", authorize(PERMISSIONS.CASH_VIEW), getDailyCashStatus);
dailyCashRouter.get("/summary", authorize(PERMISSIONS.CASH_VIEW), getDailyCashSummary);

// Routes for adding manual transactions
dailyCashRouter.post("/income", authorize(PERMISSIONS.CASH_ADD_INCOME), addIncome);
dailyCashRouter.post(
  "/expense",
  authorize(PERMISSIONS.CASH_ADD_EXPENSE),
  addExpense
);

module.exports = dailyCashRouter;