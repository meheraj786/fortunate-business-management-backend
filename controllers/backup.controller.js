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

/**
 * Creates a backup of the database and uploads folder.
 * This function can be called by cron job or manually via API.
 */
async function createBackup(req, res, next) {
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

        // 2. Dump Database
        // Extract DB name from URI if needed, or stick to default behavior of mongodump which dumps all accessible DBs or specifies via --uri
        // mongodump --uri="mongodb://..." --out="backup_folder/db_dump"
        const dumpCommand = `mongodump --uri="${DB_URI}" --out="${path.join(backupFolderPath, "db_dump")}"`;

        await new Promise((resolve, reject) => {
            exec(dumpCommand, (error, stdout, stderr) => {
                if (error) {
                    logger.error(`mongodump failed: ${error.message}`);
                    return reject(error);
                }
                resolve();
            });
        });
        logger.info("Database dump completed.");

        // 3. Copy Uploads (We will zip them directly from source to destination zip to save IO, 
        // but the requirement was "zip the uploads directory INTO the backup folder". 
        // Actually, physically copying files is slow. 
        // Better strategy: Create a ZIP file that contains:
        //  - db_dump/ (from the temp folder)
        //  - uploads/ (streamed directly from source)

        // So we already have db_dump in `backupFolderPath/db_dump`.
        // We will zip `backupFolderPath` contents AND `UPLOADS_DIR` into the final zip.

        const output = fs.createWriteStream(zipFilePath);
        const archive = archiver("zip", {
            zlib: { level: 9 }, // Sets the compression level.
        });

        await new Promise((resolve, reject) => {
            output.on("close", () => {
                logger.info(`${archive.pointer()} total bytes`);
                logger.info("Backup zip created successfully.");
                resolve();
            });

            archive.on("error", (err) => {
                reject(err);
            });

            archive.pipe(output);

            // Append database dump
            archive.directory(path.join(backupFolderPath, "db_dump"), "db_dump");

            // Append uploads directory if it exists
            if (fs.existsSync(UPLOADS_DIR)) {
                archive.directory(UPLOADS_DIR, "uploads");
            } else {
                logger.warn("Uploads directory not found, skipping files backup.");
            }

            archive.finalize();
        });

        // 4. Cleanup: Delete the temporary dump folder
        fs.rmSync(backupFolderPath, { recursive: true, force: true });
        logger.info("Temporary backup folder cleaned up.");

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
