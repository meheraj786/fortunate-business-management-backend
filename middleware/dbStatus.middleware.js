const mongoose = require("mongoose");
const { ApiError } = require("../utils/ApiError");

/**
 * Middleware to check database connection status.
 * If the database is not connected, returns a 503 Service Unavailable error.
 */
const checkDbStatus = (req, res, next) => {
  // 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
  if (mongoose.connection.readyState !== 1) {
    return next(
      new ApiError(
        503,
        "Database is currently unavailable. Please try again in a few moments.",
        [],
        "db can't connect: mongoose readyState is " +
          mongoose.connection.readyState,
      ),
    );
  }
  next();
};

module.exports = { checkDbStatus };
