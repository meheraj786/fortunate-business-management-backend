const express = require("express");
const {
  getAllTransactions,
  getTransactionDetails,
  getTransactionStats,
} = require("../../controllers/transaction.controller");
const { authenticate } = require("../../middleware/auth.middleware");
const authorize = require("../../middleware/authorize.middleware");

const transactionRoutes = express.Router();

// All routes are protected and require authentication
transactionRoutes.use(authenticate);

// Route for getting all transactions
transactionRoutes.get("/", authorize("TRANSACTION", "GET"), getAllTransactions);

// Route for getting transaction statistics
transactionRoutes.get("/stats", authorize("TRANSACTION", "GET"), getTransactionStats);

// Route for getting detailed transaction information
transactionRoutes.get("/:id", authorize("TRANSACTION", "GET"), getTransactionDetails);

module.exports = transactionRoutes;