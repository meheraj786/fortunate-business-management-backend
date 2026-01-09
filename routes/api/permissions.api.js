const express = require("express");
const {
  getAllPermissions,
} = require("../../controllers/permissions.controller");
const { authenticate } = require("../../middleware/auth.middleware");
const { authorizeRole } = require("../../middleware/authorize.middleware");

const permissionsRouter = express.Router();

permissionsRouter.get(
  "/",
  authenticate,
  authorizeRole("SUPER_ADMIN"),
  getAllPermissions
);

module.exports = permissionsRouter;
