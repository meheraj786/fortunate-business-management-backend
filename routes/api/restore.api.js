const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const {
    inspectBackup,
    restoreFromBackup,
    uploadBackup,
} = require("../../controllers/restore.controller");
const { authenticate } = require("../../middleware/auth.middleware");
const { authorizeRole } = require("../../middleware/authorize.middleware");

// All restore routes require SUPER_ADMIN — this is the most dangerous operation
router.use(authenticate);
router.use(authorizeRole("SUPER_ADMIN"));

// Configure multer for backup file uploads
const BACKUP_DIR = path.join(__dirname, "..", "..", "backups");
const upload = multer({
    dest: path.join(BACKUP_DIR, "_upload_temp"),
    limits: {
        fileSize: 500 * 1024 * 1024, // 500MB max
    },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (ext === ".zip" || file.originalname.endsWith(".zip.enc")) {
            cb(null, true);
        } else {
            cb(new Error("Only .zip and .zip.enc files are accepted"), false);
        }
    },
});

// Inspect a backup's manifest before restoring
router.get("/inspect/:filename", inspectBackup);

// Execute restore from a backup (body: { restoreUploads: bool })
router.post("/:filename", restoreFromBackup);

// Upload an external backup file
router.post("/upload", upload.single("backupFile"), uploadBackup);

module.exports = router;
