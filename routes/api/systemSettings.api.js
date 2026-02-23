const express = require("express");
const {
  getSettings,
  updateSettings,
} = require("../../controllers/systemSettings.controller");
const { authenticate } = require("../../middleware/auth.middleware");
const { authorize } = require("../../middleware/authorize.middleware");
const { PERMISSIONS } = require("../../utils/permissions.constants");

const systemSettingsRoutes = express.Router();

// Get system settings (any authenticated user can view)
systemSettingsRoutes.get("/get-settings", authenticate, getSettings);

// Update system settings (requires admin permission)
systemSettingsRoutes.patch(
  "/update-settings",
  authenticate,
  authorize(PERMISSIONS.SETTINGS_UPDATE),
  updateSettings,
);

module.exports = systemSettingsRoutes;
