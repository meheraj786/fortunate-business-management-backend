const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const archiver = require("archiver");
const { format } = require("date-fns");
const { promisify } = require("util");
const crypto = require("crypto");
const mongoose = require("mongoose");
const logger = require("../utils/logger");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const auditService = require("../services/audit.service");
const BackupHistory = require("../models/backupHistory.model");
const SystemSettings = require("../models/systemSettings.model");

// Async version of pbkdf2
const pbkdf2Async = promisify(crypto.pbkdf2);

// Configuration
const BACKUP_DIR = path.join(__dirname, "..", "backups");
const UPLOADS_DIR = path.join(__dirname, "..", "uploads");
const DB_URI = process.env.MONGODB_URI;
const APP_VERSION = require("../package.json").version || "1.0.0";

// Ensure backup directory exists (async, runs on module load)
(async () => {
    try {
        await fsp.mkdir(BACKUP_DIR, { recursive: true });
    } catch (err) {
        logger.error("Failed to create backup directory:", err);
    }
})();

const BACKUP_FILENAME_REGEX = /^backup_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.zip(\.enc)?$/;

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Helper to check if a path exists
 */
async function pathExists(filePath) {
    try {
        await fsp.access(filePath);
        return true;
    } catch {
        return false;
    }
}

/**
 * Compute SHA-256 checksum of a file using streams (memory-efficient).
 */
async function computeFileChecksum(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash("sha256");
        const stream = fs.createReadStream(filePath);
        stream.on("data", (data) => hash.update(data));
        stream.on("end", () => resolve(hash.digest("hex")));
        stream.on("error", reject);
    });
}

/**
 * Gather manifest data — queries every collection for document counts.
 */
async function gatherManifest() {
    const db = mongoose.connection.db;
    const dbName = db.databaseName;
    const collectionInfos = await db.listCollections().toArray();
    const collections = [];
    let totalDocuments = 0;

    for (const col of collectionInfos) {
        try {
            const count = await db.collection(col.name).estimatedDocumentCount();
            collections.push({ name: col.name, documentCount: count });
            totalDocuments += count;
        } catch (err) {
            logger.warn(`Could not count collection ${col.name}: ${err.message}`);
            collections.push({ name: col.name, documentCount: -1 });
        }
    }

    // Sort alphabetically for consistent ordering
    collections.sort((a, b) => a.name.localeCompare(b.name));

    return {
        appVersion: APP_VERSION,
        dbName,
        collections,
        totalDocuments,
    };
}

/**
 * Determine the retention tag for a backup based on timing.
 * - If it's the 1st of the month → "monthly"
 * - If it's the configured weekly day → "weekly"
 * - Otherwise → "daily"
 */
function determineRetentionTag(type, settings) {
    if (type === "manual") return "manual";

    const now = new Date();
    const dayOfMonth = now.getDate();
    const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat

    // Monthly: 1st of month
    if (dayOfMonth === 1) return "monthly";

    // Weekly: check configured day (default Saturday = 6)
    const dayMap = {
        Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
        Thursday: 4, Friday: 5, Saturday: 6,
    };
    const weeklyDay = dayMap[settings?.backup?.weeklyDay] ?? 6;
    if (dayOfWeek === weeklyDay) return "weekly";

    return "daily";
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE: CREATE BACKUP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a backup of the database and uploads folder.
 * This function can be called by cron job or manually via API.
 *
 * Features:
 * - MongoDB-based distributed lock (cluster-safe, replaces in-memory lock)
 * - SHA-256 integrity checksum
 * - Manifest with collection-level granularity
 * - BackupHistory tracking for every operation
 * - Smart GFS retention policy
 */
async function createBackup(req, res, next, options = {}) {
    const startTime = Date.now();
    const timestamp = format(new Date(), "yyyy-MM-dd_HH-mm-ss");
    const backupFolderName = `backup_${timestamp}`;
    const backupFolderPath = path.join(BACKUP_DIR, backupFolderName);
    const backupType = req ? "manual" : "scheduled";
    let historyRecord = null;

    try {
        // ── Step 0: Cluster-safe distributed lock ────────────────────────
        if (!options.skipLockCheck) {
            // Clean up any stale locks first (backups running > 30 min)
            const staleCount = await BackupHistory.cleanupStaleLocks();
            if (staleCount > 0) {
                logger.warn(`Cleaned up ${staleCount} stale backup lock(s).`);
            }

            // Check if another backup is currently running (across all PM2 instances)
            const isLocked = await BackupHistory.isBackupLocked();
            if (isLocked) {
                const errorMsg = "A backup process is already running. Please wait.";
                logger.warn(errorMsg);
                if (res) {
                    return res.status(409).json(new ApiError(409, errorMsg));
                }
                return; // For cron — silently skip
            }
        }

        // ── Step 1: Fetch settings ───────────────────────────────────────
        const settings = await SystemSettings.getSingleton();
        const isEncryptionEnabled = settings.backup?.encryption?.enabled;
        const password = process.env.BACKUP_ENCRYPTION_PASSWORD;

        if (isEncryptionEnabled && !password) {
            throw new Error("Encryption is enabled but BACKUP_ENCRYPTION_PASSWORD env variable is not set.");
        }

        const extension = isEncryptionEnabled ? ".zip.enc" : ".zip";
        const finalFilePath = path.join(BACKUP_DIR, `${backupFolderName}${extension}`);
        const retentionTag = determineRetentionTag(backupType, settings);

        // ── Step 2: Create history record (acts as distributed lock) ─────
        historyRecord = await BackupHistory.create({
            filename: `${backupFolderName}${extension}`,
            type: backupType,
            status: "running",
            initiatedBy: req?.user?._id || null,
            encrypted: !!isEncryptionEnabled,
            includesFiles: !!settings.backup?.includeFiles,
            retentionTag,
        });

        logger.info(`[Backup] Starting ${backupType} backup: ${backupFolderName} (tag: ${retentionTag})`);

        // ── Step 3: Gather manifest data ─────────────────────────────────
        const manifest = await gatherManifest();
        logger.info(`[Backup] Manifest: ${manifest.collections.length} collections, ${manifest.totalDocuments} documents`);

        // ── Step 4: Create temporary backup folder ───────────────────────
        await fsp.mkdir(backupFolderPath, { recursive: true });

        // ── Step 5: Dump Database ────────────────────────────────────────
        const dumpArgs = [
            "--uri", DB_URI,
            "--out", path.join(backupFolderPath, "db_dump"),
        ];

        const { spawn } = require("child_process");
        const mongodump = spawn("mongodump", dumpArgs);

        await new Promise((resolve, reject) => {
            let stderr = "";

            mongodump.stderr.on("data", (data) => {
                stderr += data.toString();
            });

            mongodump.on("error", (error) => {
                logger.error(`mongodump process error: ${error.message}`);
                reject(error);
            });

            mongodump.on("close", (code) => {
                if (code !== 0) {
                    logger.error(`mongodump failed with code ${code}: ${stderr}`);
                    return reject(new Error(`mongodump failed with code ${code}`));
                }
                resolve();
            });

            // 15 minute timeout for the process
            setTimeout(() => {
                mongodump.kill();
                reject(new Error("Backup process timed out after 15 minutes"));
            }, 15 * 60 * 1000);
        });

        logger.info("[Backup] Database dump completed.");

        // ── Step 6: Write manifest.json into the backup folder ───────────
        const manifestWithMeta = {
            ...manifest,
            backupTimestamp: new Date().toISOString(),
            backupType,
            encrypted: !!isEncryptionEnabled,
            includesFiles: !!settings.backup?.includeFiles,
            retentionTag,
            generatedBy: "Fortunate Business Management Backup System",
        };
        await fsp.writeFile(
            path.join(backupFolderPath, "manifest.json"),
            JSON.stringify(manifestWithMeta, null, 2),
            "utf8"
        );

        // ── Step 7: Create Archive ───────────────────────────────────────
        const archive = archiver("zip", {
            zlib: { level: 9 },
        });

        const output = fs.createWriteStream(finalFilePath);

        await new Promise(async (resolve, reject) => {
            if (isEncryptionEnabled) {
                const algorithm = "aes-256-gcm";
                const salt = crypto.randomBytes(16);
                const iv = crypto.randomBytes(12);
                const key = await pbkdf2Async(password, salt, 100000, 32, "sha256");
                const cipher = crypto.createCipheriv(algorithm, key, iv);

                // Write header immediately
                output.write(salt);
                output.write(iv);

                // Pipe archive to cipher
                archive.pipe(cipher);

                // Pipe cipher to output, handle end manually to write auth tag
                cipher.on("data", (chunk) => output.write(chunk));

                cipher.on("end", () => {
                    const tag = cipher.getAuthTag();
                    output.write(tag);
                    output.end();
                });

                cipher.on("error", reject);
            } else {
                archive.pipe(output);
            }

            output.on("close", () => {
                logger.info(`[Backup] Archive size: ${archive.pointer()} bytes`);
                resolve();
            });

            output.on("finish", () => {
                // fallback for encrypted pipe where "close" may fire differently
                resolve();
            });

            output.on("error", (err) => {
                if (err.code === "ENOSPC") {
                    logger.error("Disk Full! Cannot create backup.");
                    reject(new Error("Disk space exhausted. Backup failed."));
                } else {
                    reject(err);
                }
            });

            archive.on("error", reject);

            // Append database dump
            archive.directory(path.join(backupFolderPath, "db_dump"), "db_dump");

            // Append manifest.json at the root level
            archive.file(path.join(backupFolderPath, "manifest.json"), { name: "manifest.json" });

            // Append uploads if enabled
            if ((await pathExists(UPLOADS_DIR)) && settings.backup?.includeFiles) {
                archive.directory(UPLOADS_DIR, "uploads");
            } else if (!settings.backup?.includeFiles) {
                logger.info("[Backup] Skipping uploads backup based on settings.");
            } else {
                logger.warn("[Backup] Uploads directory not found, skipping files.");
            }

            archive.finalize();
        });

        // ── Step 8: Verify file integrity ────────────────────────────────
        const stats = await fsp.stat(finalFilePath);
        if (stats.size === 0) {
            throw new Error("Backup created but file is empty. Integrity check failed.");
        }

        // Compute SHA-256 checksum
        const checksum = await computeFileChecksum(finalFilePath);
        logger.info(`[Backup] Checksum (SHA-256): ${checksum}`);

        // ── Step 9: Cleanup temp folder ──────────────────────────────────
        await fsp.rm(backupFolderPath, { recursive: true, force: true });
        logger.info("[Backup] Temporary folder cleaned up.");

        // ── Step 10: Update history record with success ──────────────────
        const durationMs = Date.now() - startTime;
        historyRecord.status = "completed";
        historyRecord.sizeBytes = stats.size;
        historyRecord.durationMs = durationMs;
        historyRecord.checksum = checksum;
        historyRecord.manifest = manifest;
        await historyRecord.save();

        // ── Step 11: Smart retention policy ──────────────────────────────
        await enforceSmartRetention(settings);

        const successMessage = isEncryptionEnabled
            ? "Encrypted backup created successfully"
            : "Backup created successfully";

        logger.info(`[Backup] ${successMessage} in ${(durationMs / 1000).toFixed(1)}s`);

        // If called via API, return response
        if (res) {
            auditService.log({
                action: "BACKUP",
                module: "System",
                userId: req?.user?._id,
                description: `${successMessage}: ${backupFolderName}${extension} (${manifest.totalDocuments} docs, ${(stats.size / 1024 / 1024).toFixed(2)} MB, ${(durationMs / 1000).toFixed(1)}s)`,
                req,
            });

            return res.status(200).json(
                new ApiResponse(200, {
                    filename: `${backupFolderName}${extension}`,
                    checksum,
                    sizeBytes: stats.size,
                    durationMs,
                    manifest,
                    retentionTag,
                }, successMessage)
            );
        }

        return true; // For cron

    } catch (error) {
        logger.error("[Backup] Backup failed:", error);

        // Update history record with failure
        if (historyRecord) {
            try {
                historyRecord.status = "failed";
                historyRecord.errorMessage = error.message;
                historyRecord.durationMs = Date.now() - startTime;
                await historyRecord.save();
            } catch (saveErr) {
                logger.error("[Backup] Failed to update history record:", saveErr);
            }
        }

        // Cleanup on error (best-effort)
        try {
            if (await pathExists(backupFolderPath)) {
                await fsp.rm(backupFolderPath, { recursive: true, force: true });
            }
        } catch (cleanupErr) {
            logger.error("[Backup] Error cleaning up temp folder:", cleanupErr);
        }

        if (typeof backupFolderName !== "undefined") {
            const zip = path.join(BACKUP_DIR, `${backupFolderName}.zip`);
            const enc = path.join(BACKUP_DIR, `${backupFolderName}.zip.enc`);
            try {
                if (await pathExists(zip)) await fsp.unlink(zip);
                if (await pathExists(enc)) await fsp.unlink(enc);
            } catch (cleanupErr) {
                logger.error("[Backup] Error cleaning up partial files:", cleanupErr);
            }
        }

        if (next) {
            return next(new ApiError(500, "Backup creation failed", [], error.message));
        }
        throw error; // For cron to catch
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SMART RETENTION — Grandfather-Father-Son
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Enforces smart retention policy:
 * - Keep last N daily backups (default 7)
 * - Keep last M weekly backups (default 4)
 * - Keep last K monthly backups (default 6)
 * - Manual backups are NEVER auto-deleted
 *
 * Works by querying BackupHistory for completed backups per retention tag,
 * then deleting the oldest beyond each limit.
 */
async function enforceSmartRetention(settings) {
    const retention = settings.backup?.retention || {};
    const limits = {
        daily: retention.daily || 7,
        weekly: retention.weekly || 4,
        monthly: retention.monthly || 6,
    };

    logger.info(`[Backup] Retention policy: daily=${limits.daily}, weekly=${limits.weekly}, monthly=${limits.monthly}`);

    for (const [tag, limit] of Object.entries(limits)) {
        try {
            // Get all completed backups for this tag, newest first
            const backups = await BackupHistory.find({
                retentionTag: tag,
                status: { $in: ["completed", "verified"] },
            })
                .sort({ createdAt: -1 })
                .lean();

            if (backups.length <= limit) continue;

            // Backups beyond the limit should be deleted
            const toDelete = backups.slice(limit);

            for (const backup of toDelete) {
                const filePath = path.join(BACKUP_DIR, backup.filename);

                // Delete the file if it exists
                try {
                    if (await pathExists(filePath)) {
                        await fsp.unlink(filePath);
                        logger.info(`[Retention] Deleted file: ${backup.filename} (${tag}, exceeded limit of ${limit})`);
                    }
                } catch (delErr) {
                    logger.error(`[Retention] Failed to delete file ${backup.filename}:`, delErr);
                }

                // Update the history record status (don't delete the record — keep for audit)
                await BackupHistory.findByIdAndUpdate(backup._id, {
                    $set: { status: "failed", errorMessage: `Auto-deleted by ${tag} retention policy (limit: ${limit})` },
                });
            }
        } catch (err) {
            logger.error(`[Retention] Error enforcing ${tag} retention:`, err);
        }
    }

    // Also clean up any orphaned files on disk that don't have a history record
    try {
        const allFiles = await fsp.readdir(BACKUP_DIR);
        const backupFiles = allFiles.filter(file => file.endsWith(".zip") || file.endsWith(".zip.enc"));

        for (const file of backupFiles) {
            const hasRecord = await BackupHistory.findOne({ filename: file });
            if (!hasRecord) {
                logger.warn(`[Retention] Orphaned backup file found (no history): ${file}`);
                // Don't delete orphans — just log. Admin can clean up manually.
            }
        }
    } catch (err) {
        logger.error("[Retention] Error checking orphaned files:", err);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// LIST BACKUPS (Enhanced with history data)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lists all available backup ZIP files, enriched with history data.
 */
async function getBackups(req, res, next) {
    try {
        if (!(await pathExists(BACKUP_DIR))) {
            return res.status(200).json(new ApiResponse(200, [], "No backups found"));
        }

        const allFiles = await fsp.readdir(BACKUP_DIR);
        const backupFileNames = allFiles.filter(file => file.endsWith(".zip") || file.endsWith(".zip.enc"));

        const files = await Promise.all(
            backupFileNames.map(async (file) => {
                const stats = await fsp.stat(path.join(BACKUP_DIR, file));

                // Enrich with history data
                const history = await BackupHistory.findOne({ filename: file })
                    .populate("initiatedBy", "name email")
                    .lean();

                return {
                    filename: file,
                    size: (stats.size / 1024 / 1024).toFixed(2) + " MB",
                    sizeBytes: stats.size,
                    createdAt: stats.birthtime,
                    encrypted: file.endsWith(".zip.enc"),
                    // History-enriched fields
                    type: history?.type || "unknown",
                    status: history?.status || "unknown",
                    checksum: history?.checksum || null,
                    durationMs: history?.durationMs || null,
                    retentionTag: history?.retentionTag || "unknown",
                    notes: history?.notes || "",
                    initiatedBy: history?.initiatedBy || null,
                    manifest: history?.manifest ? {
                        collectionsCount: history.manifest.collections?.length || 0,
                        totalDocuments: history.manifest.totalDocuments || 0,
                    } : null,
                };
            })
        );

        files.sort((a, b) => b.createdAt - a.createdAt); // Newest first

        return res.status(200).json(new ApiResponse(200, files, "Backups retrieved successfully"));
    } catch (error) {
        next(new ApiError(500, "Failed to retrieve backups", [], error.message));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// BACKUP HISTORY (Paginated — includes failed/deleted records)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns paginated backup history for the audit view.
 */
async function getBackupHistory(req, res, next) {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const skip = (page - 1) * limit;

        const [history, total] = await Promise.all([
            BackupHistory.find()
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .populate("initiatedBy", "name email")
                .lean(),
            BackupHistory.countDocuments(),
        ]);

        return res.status(200).json(
            new ApiResponse(200, {
                history,
                pagination: {
                    currentPage: page,
                    totalPages: Math.ceil(total / limit),
                    totalRecords: total,
                    limit,
                },
            }, "Backup history retrieved")
        );
    } catch (error) {
        next(new ApiError(500, "Failed to retrieve backup history", [], error.message));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// VERIFY BACKUP INTEGRITY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Re-computes SHA-256 of a backup file and compares against stored checksum.
 */
async function verifyBackup(req, res, next) {
    try {
        const { filename } = req.params;

        if (!BACKUP_FILENAME_REGEX.test(filename)) {
            throw new ApiError(400, "Invalid filename provided");
        }

        const filePath = path.join(BACKUP_DIR, filename);

        if (!(await pathExists(filePath))) {
            throw new ApiError(404, "Backup file not found");
        }

        // Find history record
        const history = await BackupHistory.findOne({ filename });
        if (!history || !history.checksum) {
            throw new ApiError(400, "No checksum found for this backup. Cannot verify.");
        }

        logger.info(`[Verify] Computing checksum for ${filename}...`);
        const currentChecksum = await computeFileChecksum(filePath);
        const isValid = currentChecksum === history.checksum;

        // Update status
        history.status = isValid ? "verified" : "corrupted";
        await history.save();

        const stats = await fsp.stat(filePath);

        // Audit log
        auditService.log({
            action: "BACKUP",
            module: "System",
            userId: req.user?._id,
            description: `Backup verification ${isValid ? "PASSED" : "FAILED"}: ${filename}`,
            req,
        });

        return res.status(200).json(
            new ApiResponse(200, {
                filename,
                isValid,
                storedChecksum: history.checksum,
                currentChecksum,
                status: history.status,
                sizeBytes: stats.size,
                verifiedAt: new Date().toISOString(),
            }, isValid
                ? "Backup integrity verified — file is intact"
                : "BACKUP CORRUPTED — checksum mismatch detected!"
            )
        );
    } catch (error) {
        next(error instanceof ApiError ? error : new ApiError(500, "Verification failed", [], error.message));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// DOWNLOAD BACKUP
// ─────────────────────────────────────────────────────────────────────────────

async function downloadBackup(req, res, next) {
    try {
        const { filename } = req.params;

        if (!BACKUP_FILENAME_REGEX.test(filename)) {
            throw new ApiError(400, "Invalid filename provided");
        }

        const filePath = path.join(BACKUP_DIR, filename);

        if (!(await pathExists(filePath))) {
            throw new ApiError(404, "Backup file not found");
        }

        // Audit: Backup downloaded
        auditService.log({
            action: "BACKUP",
            module: "System",
            userId: req.user?._id,
            description: `Downloaded backup: ${filename}`,
            req,
        });

        res.download(filePath, filename, (err) => {
            if (err) {
                logger.error(`Error downloading backup: ${err.message}`);
            }
        });
    } catch (error) {
        next(error);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE BACKUP
// ─────────────────────────────────────────────────────────────────────────────

async function deleteBackup(req, res, next) {
    try {
        const { filename } = req.params;

        if (!BACKUP_FILENAME_REGEX.test(filename)) {
            throw new ApiError(400, "Invalid filename provided");
        }

        const filePath = path.join(BACKUP_DIR, filename);

        if (!(await pathExists(filePath))) {
            throw new ApiError(404, "Backup file not found");
        }

        await fsp.unlink(filePath);
        logger.info(`[Backup] Deleted: ${filename}`);

        // Update history record (mark as deleted but keep the record for audit trail)
        await BackupHistory.findOneAndUpdate(
            { filename },
            { $set: { status: "failed", errorMessage: `Manually deleted by user` } }
        );

        // Audit: Backup deleted
        auditService.log({
            action: "DELETE",
            module: "System",
            userId: req.user?._id,
            description: `Deleted backup: ${filename}`,
            req,
        });

        return res.status(200).json(new ApiResponse(200, null, "Backup deleted successfully"));
    } catch (error) {
        next(error);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE BACKUP NOTES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Add or update notes/label on a backup.
 */
async function updateBackupNotes(req, res, next) {
    try {
        const { filename } = req.params;
        const { notes } = req.body;

        if (!BACKUP_FILENAME_REGEX.test(filename)) {
            throw new ApiError(400, "Invalid filename provided");
        }

        if (typeof notes !== "string" || notes.length > 500) {
            throw new ApiError(400, "Notes must be a string with max 500 characters");
        }

        const history = await BackupHistory.findOne({ filename });
        if (!history) {
            throw new ApiError(404, "No backup record found for this file");
        }

        history.notes = notes.trim();
        await history.save();

        return res.status(200).json(
            new ApiResponse(200, { filename, notes: history.notes }, "Notes updated successfully")
        );
    } catch (error) {
        next(error instanceof ApiError ? error : new ApiError(500, "Failed to update notes", [], error.message));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
    createBackup,
    getBackups,
    getBackupHistory,
    downloadBackup,
    deleteBackup,
    verifyBackup,
    updateBackupNotes,
};
