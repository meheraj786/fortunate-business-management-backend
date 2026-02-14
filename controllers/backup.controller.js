const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const archiver = require("archiver");
const { format } = require("date-fns");
const logger = require("../utils/logger");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");

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
const BACKUP_FILENAME_REGEX = /^backup_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.zip$/;

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
    const zipFilePath = path.join(BACKUP_DIR, `${backupFolderName}.zip`);

    logger.info(`Starting backup process: ${backupFolderName}`);

    try {
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

        // Fetch settings before starting archive process
        const settings = await SystemSettings.getSingleton();

        // 3. Copy Uploads
        const output = fs.createWriteStream(zipFilePath);
        const archive = archiver("zip", {
            zlib: { level: 9 },
        });

        await new Promise((resolve, reject) => {
            output.on("close", () => {
                logger.info(`${archive.pointer()} total bytes`);
                resolve();
            });

            archive.on("error", (err) => {
                if (err.code === "ENOSPC") {
                    logger.error("Disk Full! Cannot create backup.");
                    reject(new Error("Disk space exhausted. Backup failed."));
                } else {
                    reject(err);
                }
            });

            archive.pipe(output);

            // Append database dump
            archive.directory(path.join(backupFolderPath, "db_dump"), "db_dump");

            // Append uploads directory if it exists and is enabled in settings
            if (fs.existsSync(UPLOADS_DIR) && settings.backup.includeFiles) {
                archive.directory(UPLOADS_DIR, "uploads");
            } else if (!settings.backup.includeFiles) {
                logger.info("Skipping uploads backup based on settings.");
            } else {
                logger.warn("Uploads directory not found, skipping files backup.");
            }

            archive.finalize();
        });

        // Verify Integrity
        const stats = fs.statSync(zipFilePath);
        if (stats.size === 0) {
            throw new Error("Backup created but file is empty. Integrity check failed.");
        }
        logger.info("Backup integrity check passed.");


        // 4. Cleanup: Delete the temporary dump folder
        fs.rmSync(backupFolderPath, { recursive: true, force: true });
        logger.info("Temporary backup folder cleaned up.");

        // 5. Enforce Retention Policy
        const retentionCount = settings.backup.retentionCount || 7;

        const files = fs.readdirSync(BACKUP_DIR)
            .filter(file => file.endsWith(".zip"))
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

        const successMessage = "Backup created successfully";

        // If called via API, return response
        if (res) {
            return res
                .status(200)
                .json(new ApiResponse(200, { filename: `${backupFolderName}.zip` }, successMessage));
        }

        return true; // For cron

    } catch (error) {
        logger.error("Backup failed:", error);

        // Cleanup on error
        if (fs.existsSync(backupFolderPath)) {
            fs.rmSync(backupFolderPath, { recursive: true, force: true });
        }
        // We might want to keep partial zip for debugging, or delete it. Let's delete to save space.
        if (fs.existsSync(zipFilePath)) {
            fs.unlinkSync(zipFilePath);
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
            .filter(file => file.endsWith(".zip"))
            .map(file => {
                const stats = fs.statSync(path.join(BACKUP_DIR, file));
                return {
                    filename: file,
                    size: (stats.size / 1024 / 1024).toFixed(2) + " MB",
                    createdAt: stats.birthtime,
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
