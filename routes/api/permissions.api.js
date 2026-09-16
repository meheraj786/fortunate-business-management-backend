const express = require("express");
const {
  getAllPermissions,
} = require("../../controllers/permissions.controller");
const { authenticate } = require("../../middleware/auth.middleware");
const { authorize } = require("../../middleware/authorize.middleware");
const { PERMISSIONS } = require("../../utils/permissions.constants");

const permissionsRouter = express.Router();

permissionsRouter.get(
  "/",
  authenticate,
  authorize([PERMISSIONS.USER_CREATE, PERMISSIONS.USER_UPDATE]),
  getAllPermissions
);

module.exports = permissionsRouter;
