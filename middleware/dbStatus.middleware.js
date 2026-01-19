const mongoose = require("mongoose");
const { ApiError } = require("../utils/ApiError");

/**
 * Middleware to check database connection status.
 */
const checkDbStatus = (req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    const states = ["disconnected", "connected", "connecting", "disconnecting"];
    const currentState = states[mongoose.connection.readyState] || "unknown";

    // Check if there was a specific error during initial connection
    const lastError = global.lastDbError ? `: ${global.lastDbError}` : "";

    return next(
      new ApiError(
        503,
        "Database is currently unavailable. Please try again in a few moments.",
        [],
        `db can't connect: mongoose state is '${currentState}'${lastError}`,
      ),
    );
  }
  next();
};

module.exports = { checkDbStatus };
