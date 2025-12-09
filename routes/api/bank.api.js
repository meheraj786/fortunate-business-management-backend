const express = require("express");
const {
  createAccount,
  getAllAccounts,
  getAccountById,
  updateAccount,
  deleteAccount,
} = require("../../controllers/bank.controller");
const { authMiddleware } = require("../../middleware/auth.middleware");
const authorize = require("../../middleware/authorize.middleware");

const bankRoutes = express.Router();

bankRoutes.post("/create-account", authMiddleware, authorize("BANK", "CREATE"), createAccount);
bankRoutes.get("/get-all-accounts", authMiddleware, authorize("BANK", "GET"), getAllAccounts);
bankRoutes.get("/get-account/:id", authMiddleware, authorize("BANK", "GET"), getAccountById);
bankRoutes.patch("/update-account/:id", authMiddleware, authorize("BANK", "UPDATE"), updateAccount);
bankRoutes.delete("/delete-account/:id", authMiddleware, authorize("BANK", "DELETE"), deleteAccount);

module.exports = bankRoutes;
