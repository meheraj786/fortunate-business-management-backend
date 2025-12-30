const express = require("express");
const {
  getTransactionsByAccount,
  getTransactionDetails,
  getTransactionStats,
  getAllTransactions,
  deleteTransaction,
} = require("../../controllers/transaction.controller");
const { authenticate } = require("../../middleware/auth.middleware");
const authorize = require("../../middleware/authorize.middleware");

const transactionRoutes = express.Router();

transactionRoutes.get(
  "/get-transactions-by-account/:accountId",
  authenticate,
  authorize("TRANSACTION", "GET"),
  getTransactionsByAccount
);
transactionRoutes.get(
  "/get-transaction-details/:id",
  authenticate,
  authorize("TRANSACTION", "GET"),
  getTransactionDetails
);
transactionRoutes.get(
  "/get-transaction-stats",
  authenticate,
  authorize("TRANSACTION", "GET"),
  getTransactionStats
);
transactionRoutes.get(
  "/get-all-transactions",
  authenticate,
  authorize("TRANSACTION", "GET"),
  getAllTransactions
);
// transactionRoutes.delete(
//   "/delete/:id",
//   authenticate,
//   authorize("TRANSACTION", "DELETE"),
//   deleteTransaction
// );


module.exports = transactionRoutes;
