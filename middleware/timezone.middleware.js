const SystemSettings = require("../models/systemSettings.model");
const logger = require("../utils/logger");

// In-memory cache for timezone
let cachedTimezone = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Middleware to attach business timezone to request object
 * Checks in this order:
 * 1. X-Timezone header (from frontend)
 * 2. Cached system settings (refreshed every 5 minutes)
 * 3. Environment variable (TZ)
 * 4. Default to Asia/Dhaka
 */
async function attachTimezone(req, res, next) {
  try {
    // 1. Check for timezone in request header (highest priority)
    let timezone = req.headers["x-timezone"];

    // 2. If not in header, get from cached system settings
    if (!timezone) {
      const now = Date.now();
      if (!cachedTimezone || now - cacheTimestamp > CACHE_TTL_MS) {
        const settings = await SystemSettings.getSingleton();
        cachedTimezone = settings?.timezone || null;
        cacheTimestamp = now;
      }
      timezone = cachedTimezone;
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

/**
 * Invalidate the cached timezone (call after settings update)
 */
function invalidateTimezoneCache() {
  cachedTimezone = null;
  cacheTimestamp = 0;
}

module.exports = { attachTimezone, invalidateTimezoneCache };
