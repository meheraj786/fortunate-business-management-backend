const express = require("express");
const {
  createAccount,
  getAllAccounts,
  getAccountById,
  updateAccount,
  deleteAccount,
} = require("../../controllers/bank.controller");
const { authenticate } = require("../../middleware/auth.middleware");
const authorize = require("../../middleware/authorize.middleware");

const bankRoutes = express.Router();

bankRoutes.post("/create-account", authenticate, authorize("BANK", "CREATE"), createAccount);
bankRoutes.get("/get-all-accounts", authenticate, authorize("BANK", "GET"), getAllAccounts);
bankRoutes.get("/get-account/:id", authenticate, authorize("BANK", "GET"), getAccountById);
bankRoutes.patch("/update-account/:id", authenticate, authorize("BANK", "UPDATE"), updateAccount);
bankRoutes.delete("/delete-account/:id", authenticate, authorize("BANK", "DELETE"), deleteAccount);

module.exports = bankRoutes;
