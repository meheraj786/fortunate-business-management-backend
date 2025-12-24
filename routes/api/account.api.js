const express = require("express");
const {
  createAccount,
  getAllAccounts,
  getAccountById,
  updateAccount,
  deleteAccount,
  getAccountDetails,
} = require("../../controllers/account.controller");
const { authenticate } = require("../../middleware/auth.middleware");
const authorize = require("../../middleware/authorize.middleware");

const accountRoutes = express.Router();

accountRoutes.post("/create-account", authenticate, authorize("ACCOUNT", "CREATE"), createAccount);
accountRoutes.get("/get-all-accounts", authenticate, authorize("ACCOUNT", "GET"), getAllAccounts);
accountRoutes.get("/get-account/:id", authenticate, authorize("ACCOUNT", "GET"), getAccountById);
accountRoutes.get("/get-account-details/:id", authenticate, authorize("ACCOUNT", "GET"), getAccountDetails);
accountRoutes.patch("/update-account/:id", authenticate, authorize("ACCOUNT", "UPDATE"), updateAccount);
accountRoutes.delete("/delete-account/:id", authenticate, authorize("ACCOUNT", "DELETE"), deleteAccount);

module.exports = accountRoutes;
