const express = require("express");
const router = express.Router();
const {
    createBackup,
    getBackups,
    downloadBackup,
    deleteBackup,
} = require("../../controllers/backup.controller");
const { authenticate } = require("../../middleware/auth.middleware");
const { authorizeRole } = require("../../middleware/authorize.middleware");

// All backup routes should be protected and likely restricted to Admins
router.use(authenticate);
router.use(authorizeRole("ADMIN"));

router.post("/", createBackup);
router.get("/", getBackups);
router.get("/download/:filename", downloadBackup);
router.delete("/:filename", deleteBackup);

module.exports = router;
