const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { promisify } = require("util");
const { spawn } = require("child_process");
const AdmZip = require("adm-zip");
const logger = require("../utils/logger");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const auditService = require("../services/audit.service");
const BackupHistory = require("../models/backupHistory.model");
const { createBackup } = require("./backup.controller");

const pbkdf2Async = promisify(crypto.pbkdf2);

// Configuration
const BACKUP_DIR = path.join(__dirname, "..", "backups");
const UPLOADS_DIR = path.join(__dirname, "..", "uploads");
const TEMP_RESTORE_DIR = path.join(__dirname, "..", "backups", "_restore_temp");
const DB_URI = process.env.MONGODB_URI;

const BACKUP_FILENAME_REGEX = /^backup_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.zip(\.enc)?$/;

// In-process lock for restore (only one restore at a time across the system)
// We use the same BackupHistory lock since backup and restore should not overlap.

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
 * Cleanup temp restore directory (best-effort)
 */
async function cleanupRestoreTemp() {
    try {
        if (await pathExists(TEMP_RESTORE_DIR)) {
            await fsp.rm(TEMP_RESTORE_DIR, { recursive: true, force: true });
        }
    } catch (err) {
        logger.error("[Restore] Failed to cleanup temp dir:", err);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// INSPECT BACKUP — Read manifest without full extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads manifest.json from inside a backup ZIP (or decrypts first if .enc).
 * Returns manifest data for the confirmation screen.
 */
async function inspectBackup(req, res, next) {
    try {
        const { filename } = req.params;

        if (!BACKUP_FILENAME_REGEX.test(filename)) {
            throw new ApiError(400, "Invalid filename provided");
        }

        const filePath = path.join(BACKUP_DIR, filename);
        if (!(await pathExists(filePath))) {
            throw new ApiError(404, "Backup file not found");
        }

        const isEncrypted = filename.endsWith(".zip.enc");
        let zipPath = filePath;

        // If encrypted, decrypt to a temp file first
        if (isEncrypted) {
            const password = process.env.BACKUP_ENCRYPTION_PASSWORD;
            if (!password) {
                throw new ApiError(400, "Cannot inspect encrypted backup: BACKUP_ENCRYPTION_PASSWORD env variable is not set.");
            }

            zipPath = path.join(BACKUP_DIR, `_inspect_temp_${Date.now()}.zip`);
            await decryptFile(filePath, zipPath, password);
        }

        // Extract just the manifest.json using adm-zip
        let manifest = null;
        try {
            const zip = new AdmZip(zipPath);
            const manifestEntry = zip.getEntry("manifest.json");
            if (manifestEntry) {
                const content = manifestEntry.getData().toString("utf8");
                manifest = JSON.parse(content);
            }
        } catch (extractErr) {
            logger.warn("[Restore] Could not extract manifest (may be a legacy backup):", extractErr.message);
        } finally {
            await cleanupRestoreTemp();
            // Clean up temp decrypted file
            if (isEncrypted && zipPath !== filePath) {
                try { await fsp.unlink(zipPath); } catch { /* ignore */ }
            }
        }

        // Get history record for additional metadata
        const history = await BackupHistory.findOne({ filename }).lean();
        const stats = await fsp.stat(filePath);

        return res.status(200).json(
            new ApiResponse(200, {
                filename,
                sizeBytes: stats.size,
                size: (stats.size / 1024 / 1024).toFixed(2) + " MB",
                createdAt: stats.birthtime,
                encrypted: isEncrypted,
                manifest: manifest || (history?.manifest ? {
                    appVersion: history.manifest.appVersion,
                    dbName: history.manifest.dbName,
                    collections: history.manifest.collections,
                    totalDocuments: history.manifest.totalDocuments,
                    backupTimestamp: history.createdAt,
                } : null),
                hasManifest: !!manifest,
                checksum: history?.checksum || null,
                status: history?.status || "unknown",
            }, "Backup inspected successfully")
        );
    } catch (error) {
        await cleanupRestoreTemp();
        next(error instanceof ApiError ? error : new ApiError(500, "Failed to inspect backup", [], error.message));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// RESTORE FROM BACKUP — Full restore flow
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Full restore flow:
 * 1. Validate the backup exists
 * 2. Check distributed lock (no overlapping backup/restore)
 * 3. Create a pre-restore safety backup
 * 4. Decrypt if encrypted
 * 5. Extract ZIP to temp directory
 * 6. Run mongorestore --drop
 * 7. Optionally restore uploads
 * 8. Record in BackupHistory
 * 9. Cleanup
 */
async function restoreFromBackup(req, res, next) {
    const startTime = Date.now();
    let historyRecord = null;
    let tempDecryptedPath = null;
    let safetyBackupFilename = null;
    let safetyBackupRecord = null;

    try {
        const { filename } = req.params;
        const { restoreUploads = false } = req.body;

        if (!BACKUP_FILENAME_REGEX.test(filename)) {
            throw new ApiError(400, "Invalid filename provided");
        }

        const filePath = path.join(BACKUP_DIR, filename);
        if (!(await pathExists(filePath))) {
            throw new ApiError(404, "Backup file not found");
        }

        // ── Step 0: Check distributed lock ───────────────────────────────
        await BackupHistory.cleanupStaleLocks();
        const isLocked = await BackupHistory.isBackupLocked();
        if (isLocked) {
            throw new ApiError(409, "A backup or restore process is already running. Please wait.");
        }

        const isEncrypted = filename.endsWith(".zip.enc");

        // ── Step 1: Create restore history record (acts as lock) ─────────
        historyRecord = await BackupHistory.create({
            filename: `restore_from_${filename}`,
            type: "restore",
            status: "running",
            initiatedBy: req.user._id,
            encrypted: isEncrypted,
            restoredFrom: filename,
            retentionTag: "manual",
        });

        logger.info(`[Restore] Starting restore from: ${filename} (by ${req.user.email})`);

        // ── Step 2: Create pre-restore safety backup ─────────────────────
        logger.info("[Restore] Creating pre-restore safety backup...");
        try {
            // Call createBackup without req/res to run it as a "scheduled" type
            // We'll create a minimal backup record manually
            const safetyResult = await createSafetyBackup(req.user._id);
            safetyBackupFilename = safetyResult.filename;
            safetyBackupRecord = safetyResult.record; // Save full record for re-upserting after mongorestore
            historyRecord.safetyBackupFilename = safetyBackupFilename;
            await historyRecord.save();
            logger.info(`[Restore] Safety backup created: ${safetyBackupFilename}`);
        } catch (safetyErr) {
            logger.error("[Restore] Safety backup failed:", safetyErr.message);
            throw new ApiError(500, `Pre-restore safety backup failed: ${safetyErr.message}. Restore aborted — no data was changed.`);
        }

        // ── Step 3: Decrypt if encrypted ─────────────────────────────────
        let zipPath = filePath;
        if (isEncrypted) {
            const password = process.env.BACKUP_ENCRYPTION_PASSWORD;
            if (!password) {
                throw new ApiError(400, "Cannot restore encrypted backup: BACKUP_ENCRYPTION_PASSWORD env variable is not set.");
            }
            tempDecryptedPath = path.join(BACKUP_DIR, `_restore_decrypted_${Date.now()}.zip`);
            logger.info("[Restore] Decrypting backup...");
            await decryptFile(filePath, tempDecryptedPath, password);
            zipPath = tempDecryptedPath;
            logger.info("[Restore] Decryption complete.");
        }

        // ── Step 4: Extract ZIP ──────────────────────────────────────────
        await cleanupRestoreTemp();
        await fsp.mkdir(TEMP_RESTORE_DIR, { recursive: true });
        logger.info("[Restore] Extracting backup archive...");
        const zip = new AdmZip(zipPath);
        zip.extractAllTo(TEMP_RESTORE_DIR, true);
        logger.info("[Restore] Extraction complete.");

        // ── Step 5: Read manifest for history ────────────────────────────
        const manifestPath = path.join(TEMP_RESTORE_DIR, "manifest.json");
        let manifest = null;
        if (await pathExists(manifestPath)) {
            try {
                manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
                historyRecord.manifest = {
                    appVersion: manifest.appVersion,
                    dbName: manifest.dbName,
                    collections: manifest.collections || [],
                    totalDocuments: manifest.totalDocuments || 0,
                };
            } catch { /* ignore parse errors */ }
        }

        // ── Step 6: Locate the db_dump directory ─────────────────────────
        const dbDumpPath = path.join(TEMP_RESTORE_DIR, "db_dump");
        if (!(await pathExists(dbDumpPath))) {
            throw new ApiError(400, "Invalid backup: db_dump directory not found in archive.");
        }

        // Validate: there should be at least one database folder inside db_dump
        const dbDumpContents = await fsp.readdir(dbDumpPath);
        const dbFolders = [];
        for (const item of dbDumpContents) {
            const itemPath = path.join(dbDumpPath, item);
            const stat = await fsp.stat(itemPath);
            if (stat.isDirectory()) {
                dbFolders.push(item);
            }
        }

        if (dbFolders.length === 0) {
            throw new ApiError(400, "Invalid backup: no database folder found inside db_dump.");
        }

        // ── Step 7: Run mongorestore ─────────────────────────────────────
        // IMPORTANT: --dir must point to the PARENT dump directory (db_dump/),
        // not the database subfolder (db_dump/fortunate_db/). mongorestore expects
        // the dump directory structure: db_dump/<dbname>/<collection>.bson
        logger.info(`[Restore] Running mongorestore --drop from db_dump/ (databases: ${dbFolders.join(", ")})...`);

        const restoreArgs = [
            "--uri", DB_URI,
            "--drop",
            "--dir", dbDumpPath,
        ];

        const restoreOutput = await runCommand("mongorestore", restoreArgs, 15 * 60 * 1000); // 15 min timeout
        logger.info(`[Restore] mongorestore completed successfully. Output: ${restoreOutput || "(none)"}`);


        // ── Step 8: Restore uploads if requested ─────────────────────────
        const uploadsSourcePath = path.join(TEMP_RESTORE_DIR, "uploads");
        if (restoreUploads && (await pathExists(uploadsSourcePath))) {
            logger.info("[Restore] Restoring uploads directory...");

            // Backup current uploads to a temp location first (use copy, not rename — 
            // rename fails on Windows with EPERM when files are locked by the server)
            const uploadsBackupPath = path.join(BACKUP_DIR, `_uploads_backup_${Date.now()}`);
            if (await pathExists(UPLOADS_DIR)) {
                await copyDirectory(UPLOADS_DIR, uploadsBackupPath);
                await fsp.rm(UPLOADS_DIR, { recursive: true, force: true });
            }

            try {
                // Copy restored uploads to the uploads directory
                await copyDirectory(uploadsSourcePath, UPLOADS_DIR);
                logger.info("[Restore] Uploads restored successfully.");

                // Remove the old uploads backup
                if (await pathExists(uploadsBackupPath)) {
                    await fsp.rm(uploadsBackupPath, { recursive: true, force: true });
                }
            } catch (uploadErr) {
                // Rollback: restore original uploads
                logger.error("[Restore] Uploads restoration failed, rolling back:", uploadErr);
                if (await pathExists(uploadsBackupPath)) {
                    try {
                        if (await pathExists(UPLOADS_DIR)) {
                            await fsp.rm(UPLOADS_DIR, { recursive: true, force: true });
                        }
                        await copyDirectory(uploadsBackupPath, UPLOADS_DIR);
                    } catch { /* best effort */ }
                }
                // Don't fail the whole restore for uploads — DB is already restored
                logger.warn("[Restore] Uploads restoration failed but database was restored successfully.");
            }
        } else if (restoreUploads) {
            logger.info("[Restore] No uploads directory found in backup, skipping.");
        }

        // ── Step 9: Re-upsert records wiped by mongorestore --drop ────
        // mongorestore --drop wiped the backuphistories collection and restored old data.
        // We must re-insert: (a) the restore record, (b) the safety backup record,
        // and fix (c) the source backup's "running" status.
        const durationMs = Date.now() - startTime;

        // (a) Re-upsert the restore history record
        await BackupHistory.findOneAndUpdate(
            { _id: historyRecord._id },
            {
                $set: {
                    filename: historyRecord.filename,
                    type: "restore",
                    status: "completed",
                    initiatedBy: historyRecord.initiatedBy,
                    encrypted: historyRecord.encrypted,
                    restoredFrom: historyRecord.restoredFrom,
                    retentionTag: "manual",
                    safetyBackupFilename: historyRecord.safetyBackupFilename,
                    manifest: historyRecord.manifest,
                    durationMs,
                    includesFiles: restoreUploads && (await pathExists(uploadsSourcePath)),
                    notes: `Restored from ${filename}${safetyBackupFilename ? `. Safety backup: ${safetyBackupFilename}` : ""}`,
                },
            },
            { upsert: true, new: true }
        );

        // (b) Re-upsert the safety backup record (it was wiped by --drop)
        if (safetyBackupRecord) {
            await BackupHistory.findOneAndUpdate(
                { _id: safetyBackupRecord._id },
                { $set: safetyBackupRecord },
                { upsert: true }
            );
            logger.info(`[Restore] Re-inserted safety backup record: ${safetyBackupRecord.filename}`);
        }

        // (c) Fix the source backup record — mongodump captured it as "running"
        // because the record was created before the dump and updated after.
        await BackupHistory.updateMany(
            { filename, status: "running" },
            { $set: { status: "completed" } }
        );

        // (d) Repair orphaned backup files — any backups created AFTER the backup
        // we restored from will have lost their history records. Create minimal
        // records so they don't show as "Legacy/Unknown" in the UI.
        try {
            const allFiles = await fsp.readdir(BACKUP_DIR);
            const backupFiles = allFiles.filter(f => /^backup_.*\.(zip|zip\.enc)$/.test(f));
            for (const file of backupFiles) {
                const hasRecord = await BackupHistory.findOne({ filename: file });
                if (!hasRecord) {
                    const stats = await fsp.stat(path.join(BACKUP_DIR, file));
                    await BackupHistory.create({
                        filename: file,
                        type: "manual",
                        status: "completed",
                        sizeBytes: stats.size,
                        encrypted: file.endsWith(".zip.enc"),
                        retentionTag: "manual",
                        notes: "Record recovered after restore (original metadata lost)",
                    });
                    logger.info(`[Restore] Created recovery record for orphaned backup: ${file}`);
                }
            }
        } catch (orphanErr) {
            logger.warn("[Restore] Failed to repair orphaned backup records:", orphanErr.message);
        }

        // ── Step 10: Cleanup ─────────────────────────────────────────────
        await cleanupRestoreTemp();
        if (tempDecryptedPath) {
            try { await fsp.unlink(tempDecryptedPath); } catch { /* ignore */ }
        }

        const successMsg = `Database restored successfully from ${filename} in ${(durationMs / 1000).toFixed(1)}s`;
        logger.info(`[Restore] ${successMsg}`);

        // Audit log
        auditService.log({
            action: "RESTORE",
            module: "System",
            userId: req.user._id,
            description: `${successMsg}. Safety backup: ${safetyBackupFilename || "none"}`,
            req,
        });

        return res.status(200).json(
            new ApiResponse(200, {
                restoredFrom: filename,
                safetyBackup: safetyBackupFilename,
                durationMs,
                manifest: manifest || null,
                uploadsRestored: restoreUploads,
            }, successMsg)
        );

    } catch (error) {
        logger.error("[Restore] Restore failed:", error);

        // Update history record (use upsert — mongorestore may have wiped the collection)
        if (historyRecord) {
            try {
                await BackupHistory.findOneAndUpdate(
                    { _id: historyRecord._id },
                    {
                        $set: {
                            filename: historyRecord.filename,
                            type: "restore",
                            status: "failed",
                            initiatedBy: historyRecord.initiatedBy,
                            encrypted: historyRecord.encrypted,
                            restoredFrom: historyRecord.restoredFrom,
                            retentionTag: "manual",
                            errorMessage: error.message,
                            durationMs: Date.now() - startTime,
                        },
                    },
                    { upsert: true }
                );
            } catch { /* ignore */ }
        }

        // Cleanup
        await cleanupRestoreTemp();
        if (tempDecryptedPath) {
            try { await fsp.unlink(tempDecryptedPath); } catch { /* ignore */ }
        }

        const message = error instanceof ApiError ? error.message : `Restore failed: ${error.message}`;
        next(error instanceof ApiError ? error : new ApiError(500, message, [], error.message));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// UPLOAD BACKUP — Accept external backup file
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Accepts an uploaded .zip or .zip.enc file, saves to backups dir.
 * Then inspects it and returns the manifest.
 */
async function uploadBackup(req, res, next) {
    try {
        if (!req.file) {
            throw new ApiError(400, "No file uploaded");
        }

        const originalName = req.file.originalname;

        // Validate file extension
        if (!originalName.endsWith(".zip") && !originalName.endsWith(".zip.enc")) {
            // Clean up uploaded file
            try { await fsp.unlink(req.file.path); } catch { /* ignore */ }
            throw new ApiError(400, "Invalid file type. Only .zip and .zip.enc files are accepted.");
        }

        // Validate filename format matches backup naming pattern
        if (!BACKUP_FILENAME_REGEX.test(originalName)) {
            // Clean up uploaded file
            try { await fsp.unlink(req.file.path); } catch { /* ignore */ }
            throw new ApiError(400, "Invalid backup filename format. Expected: backup_YYYY-MM-DD_HH-MM-SS.zip(.enc)");
        }

        // Move file to backups directory
        const destPath = path.join(BACKUP_DIR, originalName);

        // Check if file already exists
        if (await pathExists(destPath)) {
            try { await fsp.unlink(req.file.path); } catch { /* ignore */ }
            throw new ApiError(409, `A backup with the name "${originalName}" already exists.`);
        }

        await fsp.rename(req.file.path, destPath);

        const stats = await fsp.stat(destPath);

        // Create a minimal history record for the uploaded backup
        await BackupHistory.create({
            filename: originalName,
            type: "manual",
            status: "completed",
            initiatedBy: req.user._id,
            sizeBytes: stats.size,
            encrypted: originalName.endsWith(".zip.enc"),
            retentionTag: "manual",
            notes: "Uploaded externally",
        });

        // Audit
        auditService.log({
            action: "BACKUP",
            module: "System",
            userId: req.user._id,
            description: `Uploaded backup file: ${originalName} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`,
            req,
        });

        return res.status(200).json(
            new ApiResponse(200, {
                filename: originalName,
                sizeBytes: stats.size,
                size: (stats.size / 1024 / 1024).toFixed(2) + " MB",
                encrypted: originalName.endsWith(".zip.enc"),
            }, "Backup file uploaded successfully")
        );
    } catch (error) {
        // Clean up uploaded file on error
        if (req.file?.path) {
            try { await fsp.unlink(req.file.path); } catch { /* ignore */ }
        }
        next(error instanceof ApiError ? error : new ApiError(500, "Upload failed", [], error.message));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decrypt an AES-256-GCM encrypted backup file.
 * Format: [16-byte salt][12-byte IV][...encrypted data...][16-byte auth tag]
 */
async function decryptFile(inputPath, outputPath, password) {
    const fileBuffer = await fsp.readFile(inputPath);

    // Extract header
    const salt = fileBuffer.subarray(0, 16);
    const iv = fileBuffer.subarray(16, 28);
    const authTag = fileBuffer.subarray(fileBuffer.length - 16);
    const encryptedData = fileBuffer.subarray(28, fileBuffer.length - 16);

    // Derive key
    const key = await pbkdf2Async(password, salt, 100000, 32, "sha256");

    // Decrypt
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
        decipher.update(encryptedData),
        decipher.final(),
    ]);

    await fsp.writeFile(outputPath, decrypted);
}

/**
 * Create a pre-restore safety backup.
 * Uses the backup controller's createBackup but in a minimal mode.
 */
async function createSafetyBackup(userId) {
    // We call createBackup without req/res/next to run as scheduled
    // But we need to track it as a special safety backup
    // Skip lock check — the restore process already holds the lock,
    // so createBackup would otherwise deadlock against our own "running" record.
    const result = await createBackup(null, null, null, { skipLockCheck: true });

    if (!result) {
        throw new Error("Safety backup creation returned no result");
    }

    // Find the most recent completed backup
    const latest = await BackupHistory.findOne({
        status: "completed",
        type: { $in: ["manual", "scheduled"] },
    }).sort({ createdAt: -1 }).lean();

    if (!latest) {
        throw new Error("Safety backup created but could not find the record");
    }

    // Update it with a note
    await BackupHistory.findByIdAndUpdate(latest._id, {
        $set: { notes: `Pre-restore safety backup (auto-created)`, retentionTag: "manual" },
    });

    // Return the full record so it can be re-upserted after mongorestore --drop
    const fullRecord = await BackupHistory.findById(latest._id).lean();
    return { filename: latest.filename, record: fullRecord };
}

/**
 * Run a command as a promise.
 */
function runCommand(command, args, timeoutMs = 5 * 60 * 1000) {
    return new Promise((resolve, reject) => {
        const proc = spawn(command, args);
        let stderr = "";
        let stdout = "";

        proc.stdout.on("data", (data) => { stdout += data.toString(); });
        proc.stderr.on("data", (data) => { stderr += data.toString(); });

        proc.on("error", (error) => {
            reject(new Error(`${command} process error: ${error.message}`));
        });

        proc.on("close", (code) => {
            if (code !== 0) {
                logger.error(`${command} failed with code ${code}: ${stderr}`);
                reject(new Error(`${command} failed with exit code ${code}`));
            } else {
                resolve(stdout);
            }
        });

        setTimeout(() => {
            proc.kill();
            reject(new Error(`${command} timed out after ${timeoutMs / 1000}s`));
        }, timeoutMs);
    });
}

/**
 * Recursively copy a directory.
 */
async function copyDirectory(src, dest) {
    await fsp.mkdir(dest, { recursive: true });
    const entries = await fsp.readdir(src, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        if (entry.isDirectory()) {
            await copyDirectory(srcPath, destPath);
        } else {
            await fsp.copyFile(srcPath, destPath);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
    inspectBackup,
    restoreFromBackup,
    uploadBackup,
};
