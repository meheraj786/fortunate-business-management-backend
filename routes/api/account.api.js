const express = require("express");
const {
  createAccount,
  getAllAccounts,
  getAccountById,
  updateAccount,
  deleteAccount,
  getAccountDetails,
  searchAccounts,
} = require("../../controllers/account.controller");
const { authenticate } = require("../../middleware/auth.middleware");
const { authorize } = require("../../middleware/authorize.middleware");
const { PERMISSIONS } = require("../../utils/permissions.constants");

const accountRoutes = express.Router();

accountRoutes.post(
  "/create-account",
  authenticate,
  authorize(PERMISSIONS.ACCOUNT_CREATE),
  createAccount
);
accountRoutes.get(
  "/get-all-accounts",
  authenticate,
  // authorize(PERMISSIONS.ACCOUNT_VIEW_ALL),
  getAllAccounts
);
accountRoutes.get(
  "/search",
  authenticate,
  searchAccounts
);
accountRoutes.get(
  "/get-account/:id",
  authenticate,
  authorize(PERMISSIONS.ACCOUNT_VIEW_DETAILS),
  getAccountById
);
accountRoutes.get(
  "/get-account-details/:id",
  authenticate,
  authorize(PERMISSIONS.ACCOUNT_VIEW_DETAILS),
  getAccountDetails
);
accountRoutes.patch(
  "/update-account/:id",
  authenticate,
  authorize(PERMISSIONS.ACCOUNT_UPDATE),
  updateAccount
);
accountRoutes.delete(
  "/delete-account/:id",
  authenticate,
  authorize(PERMISSIONS.ACCOUNT_DELETE),
  deleteAccount
);

module.exports = accountRoutes;
