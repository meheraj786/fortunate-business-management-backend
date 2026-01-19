const mongoose = require("mongoose");
const logger = require("../utils/logger");

exports.dbConnect = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      // Connection pooling - CRITICAL for cluster mode (4 PM2 instances)
      maxPoolSize: 10, // Max 10 connections per instance (4 × 10 = 40 total)
      minPoolSize: 2, // Maintain at least 2 connections

      // Timeout settings
      serverSelectionTimeoutMS: 5000, // Timeout after 5s if can't connect
      socketTimeoutMS: 45000, // Close sockets after 45s inactivity

      // Error handling
      retryWrites: true,
      w: "majority",
    });

    logger.info("DB Connected");
    global.lastDbError = null; // Clear any previous error
  } catch (error) {
    logger.error("Can't Connect DB", error);
    global.lastDbError = error.message; // Capture error for the middleware
  }
};
