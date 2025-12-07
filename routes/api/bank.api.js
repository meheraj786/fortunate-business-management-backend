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

bankRoutes.post("/create-account",  createAccount);
bankRoutes.get("/get-all-accounts",  getAllAccounts);
bankRoutes.get("/get-account/:id",  getAccountById);
bankRoutes.patch("/update-account/:id",  updateAccount);
bankRoutes.delete("/delete-account/:id",  deleteAccount);

module.exports = bankRoutes;
