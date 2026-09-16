const express = require("express");
const router = express.Router();
const cleanupController = require("../controllers/dataCleanup.controller");
const { authenticate } = require("../middleware/auth.middleware");
const { authorize } = require("../middleware/authorize.middleware");
const { PERMISSIONS } = require("../utils/permissions.constants");

router.use(authenticate);

// Clear specific module
router.post("/module/:moduleName", authorize(PERMISSIONS.CLEANUP_MODULE), cleanupController.clearModuleData);

// Clear all business data (keep users/settings)
router.post("/business-data", authorize(PERMISSIONS.CLEANUP_BUSINESS_DATA), cleanupController.clearBusinessData);

// Factory Reset (Delete Everything)
router.post("/factory-reset", authorize(PERMISSIONS.CLEANUP_FACTORY_RESET), cleanupController.factoryReset);

module.exports = router;
