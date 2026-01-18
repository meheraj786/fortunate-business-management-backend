const SystemSettings = require("../models/systemSettings.model");
const logger = require("../utils/logger");

/**
 * Middleware to attach business timezone to request object
 * Checks in this order:
 * 1. X-Timezone header (from frontend)
 * 2. System settings in database
 * 3. Environment variable (TZ)
 * 4. Default to Asia/Dhaka
 */
async function attachTimezone(req, res, next) {
  try {
    // 1. Check for timezone in request header (highest priority)
    let timezone = req.headers["x-timezone"];

    // 2. If not in header, get from system settings
    if (!timezone) {
      const settings = await SystemSettings.getSingleton();
      timezone = settings?.timezone;
    }

    // 3. Fall back to environment variable or default
    if (!timezone) {
      timezone = process.env.TZ || "Asia/Dhaka";
    }

    // Attach timezone to request object
    req.businessTimezone = timezone;

    next();
  } catch (error) {
    // On error, use fallback and continue
    logger.warn("Failed to attach timezone, using fallback:", error.message);
    req.businessTimezone = process.env.TZ || "Asia/Dhaka";
    next();
  }
}

module.exports = { attachTimezone };
