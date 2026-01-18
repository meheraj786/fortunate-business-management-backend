const SystemSettings = require("../models/systemSettings.model");
const { ApiResponse } = require("../utils/ApiResponse");
const { ApiError } = require("../utils/ApiError");
const logger = require("../utils/logger");

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
    next(new ApiError(500, "An unexpected error occurred. Please try again."));
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

    // Update settings via updateSingleton
    Object.assign(settings, updateData);
    await settings.save();

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
    next(new ApiError(500, "An unexpected error occurred. Please try again."));
  }
}

module.exports = {
  getSettings,
  updateSettings,
};
