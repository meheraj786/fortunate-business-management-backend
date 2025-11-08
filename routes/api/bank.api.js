const express = require("express");
const {
  createAccount,
  getAllAccounts,
  getAccountById,
  updateAccount,
  deleteAccount,
} = require("../../controllers/bank.controller");

const bankRoutes = express.Router();

bankRoutes.post("/create-account", createAccount);
bankRoutes.get("/get-all-accounts", getAllAccounts);
bankRoutes.get("/get-account/:id", getAccountById);
bankRoutes.patch("/update-account/:id", updateAccount);
bankRoutes.delete("/delete-account/:id", deleteAccount);

module.exports = bankRoutes;
