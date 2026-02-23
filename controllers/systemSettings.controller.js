const SystemSettings = require("../models/systemSettings.model");
const { ApiResponse } = require("../utils/ApiResponse");
const { ApiError } = require("../utils/ApiError");
const logger = require("../utils/logger");
const { invalidateTimezoneCache } = require("../middleware/timezone.middleware");

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
    if (updateData.backup) {
      if (updateData.backup.frequency && !["Daily", "Weekly", "Monthly"].includes(updateData.backup.frequency)) {
        throw new ApiError(400, "Invalid frequency. Must be Daily, Weekly, or Monthly.");
      }
      if (updateData.backup.time && !/^([01]\d|2[0-3]):([0-5]\d)$/.test(updateData.backup.time)) {
        throw new ApiError(400, "Invalid time format. Must be HH:mm (24h).");
      }
      if (updateData.backup.retentionCount) {
        const count = parseInt(updateData.backup.retentionCount);
        if (isNaN(count) || count < 1 || count > 365) {
          throw new ApiError(400, "Retention count must be between 1 and 365.");
        }
      }
      // Encryption validation
      if (updateData.backup.encryption && updateData.backup.encryption.enabled) {
        if (!updateData.backup.encryption.password && !settings.backup?.encryption?.password) {
          throw new ApiError(400, "Password is required to enable encryption.");
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
      if (updateData.backup.includeFiles !== undefined) settings.backup.includeFiles = updateData.backup.includeFiles;

      if (updateData.backup.encryption) {
        if (!settings.backup.encryption) settings.backup.encryption = {};
        if (updateData.backup.encryption.enabled !== undefined) settings.backup.encryption.enabled = updateData.backup.encryption.enabled;
        if (updateData.backup.encryption.password) settings.backup.encryption.password = updateData.backup.encryption.password;
      }
    }

    // Remove backup from updateData to prevent overwriting the merged object above with Object.assign potentially
    delete updateData.backup;

    Object.assign(settings, updateData);
    await settings.save();

    // Invalidate timezone cache so changes take effect immediately
    invalidateTimezoneCache();

    // Reschedule backup job if backup settings changed
    if (updateData.backup) {
      const { rescheduleBackupJob } = require("../services/backupScheduler.service");
      await rescheduleBackupJob();
    }

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
