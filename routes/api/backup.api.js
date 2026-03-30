const express = require("express");
const router = express.Router();
const {
    createBackup,
    getBackups,
    getBackupHistory,
    downloadBackup,
    deleteBackup,
    verifyBackup,
    updateBackupNotes,
} = require("../../controllers/backup.controller");
const { authenticate } = require("../../middleware/auth.middleware");
const { authorizeRole } = require("../../middleware/authorize.middleware");

// All backup routes are protected and restricted to Admins
router.use(authenticate);
router.use(authorizeRole("ADMIN"));

// Core CRUD
router.post("/", createBackup);
router.get("/", getBackups);
router.get("/download/:filename", downloadBackup);
router.delete("/:filename", deleteBackup);

// New endpoints
router.get("/history", getBackupHistory);
router.post("/verify/:filename", verifyBackup);
router.patch("/:filename/notes", updateBackupNotes);

module.exports = router;
