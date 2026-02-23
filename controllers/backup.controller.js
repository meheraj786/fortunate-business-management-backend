const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const archiver = require("archiver");
const { format } = require("date-fns");
const logger = require("../utils/logger");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const crypto = require("crypto");
const auditService = require("../services/audit.service");

// Configuration
const BACKUP_DIR = path.join(__dirname, "..", "backups");
const UPLOADS_DIR = path.join(__dirname, "..", "uploads");
const DB_URI = process.env.MONGODB_URI;

// Ensure backup directory exists
if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

const SystemSettings = require("../models/systemSettings.model");

// In-memory lock to prevent overlapping backups
let isBackupRunning = false;
const BACKUP_FILENAME_REGEX = /^backup_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.zip(\.enc)?$/;

/**
 * Creates a backup of the database and uploads folder.
 * This function can be called by cron job or manually via API.
 */
async function createBackup(req, res, next) {
    if (isBackupRunning) {
        const errorMsg = "A backup process is already running. Please wait.";
        logger.warn(errorMsg);
        if (res) {
            return res.status(409).json(new ApiError(409, errorMsg));
        }
        return; // For cron
    }

    isBackupRunning = true;
    const timestamp = format(new Date(), "yyyy-MM-dd_HH-mm-ss");
    const backupFolderName = `backup_${timestamp}`;
    const backupFolderPath = path.join(BACKUP_DIR, backupFolderName);

    logger.info(`Starting backup process: ${backupFolderName}`);

    try {
        // Fetch settings first to determine encryption
        const settings = await SystemSettings.getSingleton();
        const isEncryptionEnabled = settings.backup?.encryption?.enabled;

        // SEC-3: Read encryption password from environment variable (not DB)
        const password = process.env.BACKUP_ENCRYPTION_PASSWORD;

        if (isEncryptionEnabled && !password) {
            throw new Error("Encryption is enabled but BACKUP_ENCRYPTION_PASSWORD env variable is not set. Cannot create backup.");
        }

        const extension = isEncryptionEnabled ? ".zip.enc" : ".zip";
        const finalFilePath = path.join(BACKUP_DIR, `${backupFolderName}${extension}`);

        // 1. Create temporary backup folder
        if (!fs.existsSync(backupFolderPath)) {
            fs.mkdirSync(backupFolderPath);
        }

        // 2. Dump Database using SPAWN for security (Command Injection Prevention)
        const dumpArgs = [
            "--uri", DB_URI,
            "--out", path.join(backupFolderPath, "db_dump")
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

        logger.info("Database dump completed.");

        // 3. Create Archive
        const archive = archiver("zip", {
            zlib: { level: 9 },
        });

        const output = fs.createWriteStream(finalFilePath);

        // Let's restructure the piping and promise:

        await new Promise((resolve, reject) => {
            if (isEncryptionEnabled) {
                const algorithm = "aes-256-gcm";
                const salt = crypto.randomBytes(16);
                const iv = crypto.randomBytes(12);
                const key = crypto.pbkdf2Sync(password, salt, 100000, 32, "sha256");
                const cipher = crypto.createCipheriv(algorithm, key, iv);

                // Write header immediately
                output.write(salt);
                output.write(iv);

                // Pipe archive to cipher
                archive.pipe(cipher);

                // Pipe cipher to output, but handle end manually to write auth tag
                cipher.on("data", (chunk) => output.write(chunk));

                cipher.on("end", () => {
                    const tag = cipher.getAuthTag();
                    output.write(tag);
                    output.end();
                    // Resolve handled by output finish
                });

                cipher.on("error", reject);
            } else {
                archive.pipe(output);
            }

            output.on("close", () => {
                logger.info(`${archive.pointer()} total bytes`);
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

            // Append contents
            archive.directory(path.join(backupFolderPath, "db_dump"), "db_dump");

            if (fs.existsSync(UPLOADS_DIR) && settings.backup?.includeFiles) {
                archive.directory(UPLOADS_DIR, "uploads");
            } else if (!settings.backup?.includeFiles) {
                logger.info("Skipping uploads backup based on settings.");
            } else {
                logger.warn("Uploads directory not found, skipping files backup.");
            }

            archive.finalize();
        });

        // Verify Integrity
        const stats = fs.statSync(finalFilePath);
        if (stats.size === 0) {
            throw new Error("Backup created but file is empty. Integrity check failed.");
        }
        logger.info(`Backup integrity check passed. Encrypted: ${isEncryptionEnabled}`);

        // 4. Cleanup
        fs.rmSync(backupFolderPath, { recursive: true, force: true });
        logger.info("Temporary backup folder cleaned up.");

        // 5. Enforce Retention Policy
        const retentionCount = settings.backup?.retentionCount || 7;

        const files = fs.readdirSync(BACKUP_DIR)
            .filter(file => file.endsWith(".zip") || file.endsWith(".zip.enc"))
            .map(file => ({
                name: file,
                time: fs.statSync(path.join(BACKUP_DIR, file)).birthtime.getTime()
            }))
            .sort((a, b) => b.time - a.time); // Newest first

        if (files.length > retentionCount) {
            const filesToDelete = files.slice(retentionCount);
            filesToDelete.forEach(file => {
                fs.unlinkSync(path.join(BACKUP_DIR, file.name));
                logger.info(`Deleted old backup: ${file.name} (Retention Policy)`);
            });
        }

        const successMessage = isEncryptionEnabled
            ? "Encrypted backup created successfully"
            : "Backup created successfully";

        // If called via API, return response
        if (res) {
            // Audit: Backup created
            auditService.log({ action: "BACKUP", module: "System", userId: req?.user?._id, description: `${successMessage}: ${backupFolderName}${extension}`, req });

            return res
                .status(200)
                .json(new ApiResponse(200, { filename: `${backupFolderName}${extension}` }, successMessage));
        }

        return true; // For cron

    } catch (error) {
        logger.error("Backup failed:", error);

        // Cleanup on error
        if (fs.existsSync(backupFolderPath)) {
            fs.rmSync(backupFolderPath, { recursive: true, force: true });
        }
        // Ideally verify variable existence before unlink, but backupFolderName is defined early
        // Safe to try cleanup based on logic
        // We need to know the final file path, which might be .zip or .zip.enc
        // Best effort cleanup:
        if (typeof backupFolderName !== 'undefined') {
            const zip = path.join(BACKUP_DIR, `${backupFolderName}.zip`);
            const enc = path.join(BACKUP_DIR, `${backupFolderName}.zip.enc`);
            if (fs.existsSync(zip)) fs.unlinkSync(zip);
            if (fs.existsSync(enc)) fs.unlinkSync(enc);
        }

        if (next) {
            return next(new ApiError(500, "Backup creation failed", [], error.message));
        }
        throw error; // For cron to catch
    } finally {
        isBackupRunning = false;
    }
}

/**
 * Lists all available backup zip files.
 */
async function getBackups(req, res, next) {
    try {
        if (!fs.existsSync(BACKUP_DIR)) {
            return res.status(200).json(new ApiResponse(200, [], "No backups found"));
        }

        const files = fs.readdirSync(BACKUP_DIR)
            .filter(file => file.endsWith(".zip") || file.endsWith(".zip.enc"))
            .map(file => {
                const stats = fs.statSync(path.join(BACKUP_DIR, file));
                return {
                    filename: file,
                    size: (stats.size / 1024 / 1024).toFixed(2) + " MB",
                    createdAt: stats.birthtime,
                    encrypted: file.endsWith(".zip.enc") // Flag for frontend
                };
            })
            .sort((a, b) => b.createdAt - a.createdAt); // Newest first

        return res.status(200).json(new ApiResponse(200, files, "Backups retrieved successfully"));
    } catch (error) {
        next(new ApiError(500, "Failed to retrieve backups", [], error.message));
    }
}

/**
 * Downloads a specific backup file.
 */
async function downloadBackup(req, res, next) {
    try {
        const { filename } = req.params;

        // Path Traversal Protection
        if (!BACKUP_FILENAME_REGEX.test(filename)) {
            throw new ApiError(400, "Invalid filename provided");
        }

        const filePath = path.join(BACKUP_DIR, filename);

        if (!fs.existsSync(filePath)) {
            throw new ApiError(404, "Backup file not found");
        }

        res.download(filePath, filename, (err) => {
            if (err) {
                logger.error(`Error downloading backup: ${err.message}`);
                // Note: Can't send error response if headers already sent
            }
        });
    } catch (error) {
        next(error);
    }
}

/**
 * Deletes a specific backup file.
 */
async function deleteBackup(req, res, next) {
    try {
        const { filename } = req.params;

        // Path Traversal Protection
        if (!BACKUP_FILENAME_REGEX.test(filename)) {
            throw new ApiError(400, "Invalid filename provided");
        }

        const filePath = path.join(BACKUP_DIR, filename);

        if (!fs.existsSync(filePath)) {
            throw new ApiError(404, "Backup file not found");
        }

        fs.unlinkSync(filePath);
        logger.info(`Backup deleted: ${filename}`);

        // Audit: Backup deleted
        auditService.log({ action: "DELETE", module: "System", userId: req.user?._id, description: `Deleted backup: ${filename}`, req });

        return res.status(200).json(new ApiResponse(200, null, "Backup deleted successfully"));
    } catch (error) {
        next(error);
    }
}

module.exports = {
    createBackup,
    getBackups,
    downloadBackup,
    deleteBackup
};
