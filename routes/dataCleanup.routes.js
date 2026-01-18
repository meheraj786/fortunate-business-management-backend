const express = require("express");
const router = express.Router();
const cleanupController = require("../controllers/dataCleanup.controller");
const { authenticate } = require("../middleware/auth.middleware");
const { authorize } = require("../middleware/authorize.middleware");

// All cleanup routes require SUPER_ADMIN privileges
router.use(authenticate); // Ensure user is logged in
router.use(authorize("SUPER_ADMIN")); // Strict restriction

// Clear specific module
router.post("/module/:moduleName", cleanupController.clearModuleData);

// Clear all business data (keep users/settings)
router.post("/business-data", cleanupController.clearBusinessData);

// Factory Reset (Delete Everything)
router.post("/factory-reset", cleanupController.factoryReset);

module.exports = router;
