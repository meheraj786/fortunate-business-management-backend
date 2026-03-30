const SystemSettings = require("../models/systemSettings.model");
const { ApiResponse } = require("../utils/ApiResponse");
const { ApiError } = require("../utils/ApiError");
const logger = require("../utils/logger");
const { reloadConsoleTransport } = require("../utils/logger");
const { invalidateTimezoneCache } = require("../middleware/timezone.middleware");
const auditService = require("../services/audit.service");

/**
 * Get system settings
 */
async function getSettings(req, res, next) {
  try {
    const settings = await SystemSettings.getSingleton();
    return res
      .status(200)
      .json(new ApiResponse(200, settings, "Settings fetched successfully"));
  } catch (error) {
    logger.error("Get settings failed:", {
      message: error.message,
      stack: error.stack,
    });
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
}

/**
 * Update system settings
 * CRITICAL: Timezone can only be set ONCE by SuperAdmin
 */
async function updateSettings(req, res, next) {
  try {
    const updateData = req.body;
    const settings = await SystemSettings.getSingleton();

    // CRITICAL: Check if trying to change timezone after it's been set
    if (updateData.timezone && settings.isTimezoneSet) {
      throw new ApiError(
        403,
        "Timezone has already been permanently set and cannot be changed. This is to prevent data inconsistencies.",
      );
    }

    // Validate timezone if provided
    if (updateData.timezone) {
      const validTimezones = [
        "America/New_York",
        "America/Chicago",
        "America/Denver",
        "America/Los_Angeles",
        "America/Toronto",
        "America/Sao_Paulo",
        "Europe/London",
        "Europe/Paris",
        "Europe/Berlin",
        "Europe/Rome",
        "Europe/Moscow",
        "Europe/Istanbul",
        "Asia/Dubai",
        "Asia/Karachi",
        "Asia/Kolkata",
        "Asia/Dhaka",
        "Asia/Bangkok",
        "Asia/Singapore",
        "Asia/Hong_Kong",
        "Asia/Shanghai",
        "Asia/Tokyo",
        "Asia/Seoul",
        "Australia/Sydney",
        "Australia/Melbourne",
        "Pacific/Auckland",
        "Africa/Cairo",
        "Africa/Johannesburg",
        "Africa/Lagos",
      ];

      if (!validTimezones.includes(updateData.timezone)) {
        throw new ApiError(
          400,
          `Invalid timezone. Must be one of: ${validTimezones.join(", ")}`,
        );
      }

      // Mark timezone as permanently set
      updateData.isTimezoneSet = true;
      updateData.timezoneSetAt = new Date();
      updateData.timezoneSetBy = req.user._id; // From authenticate middleware

      logger.info(
        `Timezone permanently set to ${updateData.timezone} by user ${req.user._id}`,
      );
    }

    // Validate Backup Settings
    let backupSettingsChanged = false;
    if (updateData.backup) {
      backupSettingsChanged = true;
      if (updateData.backup.frequency && !["Daily", "Weekly", "Monthly"].includes(updateData.backup.frequency)) {
        throw new ApiError(400, "Invalid frequency. Must be Daily, Weekly, or Monthly.");
      }
      if (updateData.backup.time && !/^([01]\d|2[0-3]):([0-5]\d)$/.test(updateData.backup.time)) {
        throw new ApiError(400, "Invalid time format. Must be HH:mm (24h).");
      }
      if (updateData.backup.weeklyDay) {
        const validDays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
        if (!validDays.includes(updateData.backup.weeklyDay)) {
          throw new ApiError(400, `Invalid weekly day. Must be one of: ${validDays.join(", ")}`);
        }
      }
      if (updateData.backup.retentionCount) {
        const count = parseInt(updateData.backup.retentionCount);
        if (isNaN(count) || count < 1 || count > 365) {
          throw new ApiError(400, "Retention count must be between 1 and 365.");
        }
      }
      // Validate smart retention limits
      if (updateData.backup.retention) {
        const r = updateData.backup.retention;
        if (r.daily !== undefined && (r.daily < 1 || r.daily > 90)) {
          throw new ApiError(400, "Daily retention must be between 1 and 90.");
        }
        if (r.weekly !== undefined && (r.weekly < 1 || r.weekly > 52)) {
          throw new ApiError(400, "Weekly retention must be between 1 and 52.");
        }
        if (r.monthly !== undefined && (r.monthly < 1 || r.monthly > 24)) {
          throw new ApiError(400, "Monthly retention must be between 1 and 24.");
        }
      }
      // Encryption validation
      if (updateData.backup.encryption && updateData.backup.encryption.enabled) {
        // SEC-3: Password must be set via BACKUP_ENCRYPTION_PASSWORD env variable
        if (!process.env.BACKUP_ENCRYPTION_PASSWORD) {
          throw new ApiError(400, "Cannot enable encryption: BACKUP_ENCRYPTION_PASSWORD environment variable is not set. Please set it in your .env file.");
        }
      }
    }

    // Update settings via updateSingleton
    // Handling nested updates for backup.encryption is tricky with Object.assign if not careful, 
    // but Mongoose handles dot notation in update queries. Here we are assigning to a document instance.
    // We need to be careful not to overwrite the password if it's not provided in the update but exists.

    if (updateData.backup) {
      // Merge backup settings carefully
      settings.backup.frequency = updateData.backup.frequency || settings.backup.frequency;
      settings.backup.time = updateData.backup.time || settings.backup.time;
      settings.backup.retentionCount = updateData.backup.retentionCount || settings.backup.retentionCount;
      if (updateData.backup.weeklyDay) settings.backup.weeklyDay = updateData.backup.weeklyDay;
      if (updateData.backup.includeFiles !== undefined) settings.backup.includeFiles = updateData.backup.includeFiles;

      // Smart retention limits
      if (updateData.backup.retention) {
        if (!settings.backup.retention) settings.backup.retention = {};
        if (updateData.backup.retention.daily !== undefined) settings.backup.retention.daily = updateData.backup.retention.daily;
        if (updateData.backup.retention.weekly !== undefined) settings.backup.retention.weekly = updateData.backup.retention.weekly;
        if (updateData.backup.retention.monthly !== undefined) settings.backup.retention.monthly = updateData.backup.retention.monthly;
      }

      if (updateData.backup.encryption) {
        if (!settings.backup.encryption) settings.backup.encryption = {};
        if (updateData.backup.encryption.enabled !== undefined) settings.backup.encryption.enabled = updateData.backup.encryption.enabled;
        // SEC-3: Do NOT store password in DB — it's read from env variable only
      }
    }

    // Handle logging settings
    if (updateData.logging) {
      const validLevels = ["error", "warn", "info", "debug"];
      if (updateData.logging.consoleLevel && !validLevels.includes(updateData.logging.consoleLevel)) {
        throw new ApiError(400, `Invalid console level. Must be one of: ${validLevels.join(", ")}`);
      }
      if (!settings.logging) settings.logging = {};
      if (updateData.logging.consoleEnabled !== undefined) settings.logging.consoleEnabled = updateData.logging.consoleEnabled;
      if (updateData.logging.consoleLevel) settings.logging.consoleLevel = updateData.logging.consoleLevel;
    }

    // Remove backup and logging from updateData to prevent overwriting the merged objects above with Object.assign
    delete updateData.backup;
    delete updateData.logging;

    Object.assign(settings, updateData);
    await settings.save();

    // Invalidate timezone cache so changes take effect immediately
    invalidateTimezoneCache();

    // Reschedule backup job if backup settings changed
    if (backupSettingsChanged) {
      const { rescheduleBackupJob } = require("../services/backupScheduler.service");
      await rescheduleBackupJob();
    }

    // Hot-reload console transport if logging settings changed
    reloadConsoleTransport(
      settings.logging?.consoleEnabled ?? true,
      settings.logging?.consoleLevel ?? "error"
    );

    // Audit: Settings updated
    auditService.log({ action: "SETTINGS_UPDATE", module: "System", userId: req.user?._id, description: updateData.isTimezoneSet ? `Timezone permanently set to ${settings.timezone}` : "System settings updated", req });

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          settings,
          updateData.isTimezoneSet
            ? "Timezone set successfully and locked permanently"
            : "Settings updated successfully",
        ),
      );
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    logger.error("Update settings failed:", {
      message: error.message,
      stack: error.stack,
    });
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
}

module.exports = {
  getSettings,
  updateSettings,
};
