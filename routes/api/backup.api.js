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
    getBackupReadiness,
} = require("../../controllers/backup.controller");
const { authenticate } = require("../../middleware/auth.middleware");
const { authorize } = require("../../middleware/authorize.middleware");
const { PERMISSIONS } = require("../../utils/permissions.constants");

// Every operation is protected by an explicit granular permission.
router.use(authenticate);

// Core CRUD
router.post("/", authorize(PERMISSIONS.BACKUP_CREATE), createBackup);
router.get("/", authorize(PERMISSIONS.BACKUP_VIEW), getBackups);
router.get("/readiness", authorize(PERMISSIONS.BACKUP_VIEW), getBackupReadiness);
router.get("/download/:filename", authorize(PERMISSIONS.BACKUP_DOWNLOAD), downloadBackup);
router.delete("/:filename", authorize(PERMISSIONS.BACKUP_DELETE), deleteBackup);

// New endpoints
router.get("/history", authorize(PERMISSIONS.BACKUP_VIEW), getBackupHistory);
router.post("/verify/:filename", authorize(PERMISSIONS.BACKUP_VERIFY), verifyBackup);
router.patch("/:filename/notes", authorize(PERMISSIONS.BACKUP_UPDATE_NOTES), updateBackupNotes);

module.exports = router;
