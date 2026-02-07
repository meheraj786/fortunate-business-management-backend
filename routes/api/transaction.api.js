const express = require("express");
const {
  getTransactionsByAccount,
  getTransactionDetails,
  getTransactionStats,
  getAllTransactions,
  deleteTransaction,
  createTransaction,
  updateTransaction,
  transferMoney,
} = require("../../controllers/transaction.controller");
const { authenticate } = require("../../middleware/auth.middleware");
const { authorize } = require("../../middleware/authorize.middleware");
const { PERMISSIONS } = require("../../utils/permissions.constants");

const transactionRoutes = express.Router();

transactionRoutes.use(authenticate);

transactionRoutes.post(
  "/create-transaction",
  authorize(PERMISSIONS.TRANSACTION_CREATE),
  createTransaction
);
transactionRoutes.get(
  "/get-all-transactions",
  authorize(PERMISSIONS.TRANSACTION_VIEW_ALL),
  getAllTransactions
);
transactionRoutes.get(
  "/get-transactions-by-account/:accountId",
  authorize(PERMISSIONS.TRANSACTION_VIEW_ALL),
  getTransactionsByAccount
);
transactionRoutes.get(
  "/get-transaction-details/:id",
  authorize(PERMISSIONS.TRANSACTION_VIEW_DETAILS),
  getTransactionDetails
);
transactionRoutes.get(
  "/get-transaction-stats",
  authorize(PERMISSIONS.TRANSACTION_VIEW_ALL),
  getTransactionStats
);
transactionRoutes.patch(
  "/update-transaction/:id",
  authorize(PERMISSIONS.TRANSACTION_UPDATE),
  updateTransaction
);
transactionRoutes.delete(
  "/delete-transaction/:id",
  authorize(PERMISSIONS.TRANSACTION_DELETE),
  deleteTransaction
);

transactionRoutes.post(
  "/transfer",
  authorize(PERMISSIONS.TRANSACTION_CREATE),
  transferMoney
);

module.exports = transactionRoutes;
