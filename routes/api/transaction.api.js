const express = require("express");
const {
  createTransaction,
  getAllTransactions,
  getTransactionById,
  getTransactionsByAccountId,
  deleteTransaction,
  getTransactionStats,
} = require("../../controllers/transaction.controller");

const transactionRoutes = express.Router();

transactionRoutes.post("/create", createTransaction);
transactionRoutes.get("/get-all", getAllTransactions);
transactionRoutes.get("/get-stats", getTransactionStats);
transactionRoutes.get("/get/:id", getTransactionById);
transactionRoutes.get("/get-by-account/:accountId", getTransactionsByAccountId);
transactionRoutes.delete("/delete/:id", deleteTransaction);

module.exports = transactionRoutes;
