const cron = require("node-cron");
const SystemSettings = require("../models/systemSettings.model");
const { createBackup } = require("../controllers/backup.controller");
const logger = require("../utils/logger");

let backupTask = null;

/**
 * Converts settings into a cron expression
 * @param {string} frequency - Daily, Weekly, Monthly
 * @param {string} time - HH:mm
 * @param {string} weeklyDay - Day of week for Weekly frequency (e.g., "Saturday")
 */
const getCronExpression = (frequency, time, weeklyDay) => {
    const [hour, minute] = time.split(":");

    // Validate time format roughly
    const h = parseInt(hour) || 2;
    const m = parseInt(minute) || 0;

    if (frequency === "Weekly") {
        // Map day name to cron day number (0=Sunday, 6=Saturday)
        const dayMap = {
            Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
            Thursday: 4, Friday: 5, Saturday: 6,
        };
        const dayNum = dayMap[weeklyDay] ?? 6; // Default Saturday
        return `${m} ${h} * * ${dayNum}`;
    } else if (frequency === "Monthly") {
        // 1st day of the month
        return `${m} ${h} 1 * *`;
    } else {
        // Daily (Default)
        return `${m} ${h} * * *`;
    }
};

/**
 * Initializes the backup job on server startup.
 */
const initBackupJob = async () => {
    try {
        const settings = await SystemSettings.getSingleton();
        const { frequency, time, weeklyDay } = settings.backup;

        // Default fallback if settings are missing (schema update migration)
        const freq = frequency || "Daily";
        const t = time || "02:00";
        const day = weeklyDay || "Saturday";

        scheduleJob(freq, t, day);
    } catch (error) {
        logger.error("Failed to init backup job:", error);
    }
};

/**
 * Reschedules the backup job (called when settings change).
 */
const rescheduleBackupJob = async () => {
    try {
        const settings = await SystemSettings.getSingleton();
        const { frequency, time, weeklyDay } = settings.backup;

        scheduleJob(frequency, time, weeklyDay);
    } catch (error) {
        logger.error("Failed to reschedule backup job:", error);
    }
};

/**
 * Internal: Creates and starts the cron job.
 *
 * CLUSTER SAFETY NOTE:
 * In PM2 cluster mode, this cron fires on ALL instances simultaneously.
 * This is intentional — the backup controller uses a MongoDB-based distributed lock
 * (BackupHistory.isBackupLocked()) so only the first instance to acquire the lock
 * actually runs the backup. All others are harmlessly rejected.
 */
const scheduleJob = (frequency, time, weeklyDay) => {
    if (backupTask) {
        backupTask.stop();
        logger.info("Previous backup job stopped.");
    }

    const cronExpression = getCronExpression(frequency, time, weeklyDay || "Saturday");
    const timezone = process.env.TZ || "Asia/Dhaka";

    logger.info(`Scheduling backup job: ${frequency} at ${time} (day: ${weeklyDay || "N/A"}) [${cronExpression}]`);

    backupTask = cron.schedule(
        cronExpression,
        () => {
            logger.info("Running scheduled backup (cluster-safe: DB lock will deduplicate)...");
            // Pass no req/res/next — indicates this is a scheduled (cron) backup
            createBackup().catch((err) => {
                // Errors are already logged inside createBackup; this catch prevents unhandled rejection
                logger.error("Scheduled backup cron error:", err.message);
            });
        },
        {
            scheduled: true,
            timezone,
        }
    );
};

module.exports = {
    initBackupJob,
    rescheduleBackupJob,
};
