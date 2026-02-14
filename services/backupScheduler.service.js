const cron = require("node-cron");
const SystemSettings = require("../models/systemSettings.model");
const { createBackup } = require("../controllers/backup.controller");
const logger = require("../utils/logger");

let backupTask = null;

/**
 * Converts settings into a cron expression
 * @param {string} frequency - Daily, Weekly, Monthly
 * @param {string} time - HH:mm
 */
const getCronExpression = (frequency, time) => {
    const [hour, minute] = time.split(":");

    // Validate time format roughly
    const h = parseInt(hour) || 2;
    const m = parseInt(minute) || 0;

    if (frequency === "Weekly") {
        // Every Friday at specified time (Friday is weekend in BD context often, but let's stick to standard)
        // Actually, "Weekly" usually implies a specific day. Let's pick Friday (5) as it's common in this region, or Monday.
        // Let's use Friday for now.
        return `${m} ${h} * * 5`;
    } else if (frequency === "Monthly") {
        // 1st day of the month
        return `${m} ${h} 1 * *`;
    } else {
        // Daily (Default)
        return `${m} ${h} * * *`;
    }
};

/**
 * Initializes the backup job on server startup
 */
const initBackupJob = async () => {
    try {
        const settings = await SystemSettings.getSingleton();
        const { frequency, time } = settings.backup;

        // Default fallback if settings are missing (schema update migration)
        const freq = frequency || "Daily";
        const t = time || "02:00";

        scheduleJob(freq, t);
    } catch (error) {
        logger.error("Failed to init backup job:", error);
    }
};

/**
 * Reschedules the backup job (called when settings change)
 */
const rescheduleBackupJob = async () => {
    try {
        const settings = await SystemSettings.getSingleton();
        const { frequency, time } = settings.backup;

        scheduleJob(frequency, time);
    } catch (error) {
        logger.error("Failed to reschedule backup job:", error);
    }
};

const scheduleJob = (frequency, time) => {
    if (backupTask) {
        backupTask.stop();
        logger.info("Previous backup job stopped.");
    }

    const cronExpression = getCronExpression(frequency, time);
    const timezone = process.env.TZ || "Asia/Dhaka";

    logger.info(`Scheduling backup job: ${frequency} at ${time} (${cronExpression})`);

    backupTask = cron.schedule(
        cronExpression,
        () => {
            logger.info("Running scheduled backup...");
            createBackup();
        },
        {
            scheduled: true,
            timezone,
        }
    );
};

module.exports = {
    initBackupJob,
    rescheduleBackupJob
};
