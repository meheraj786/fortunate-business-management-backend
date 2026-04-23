const mongoose = require("mongoose");
const dns = require("dns");
const logger = require("../utils/logger");

// Fix DNS: system DNS is 127.0.0.1 which fails for Node.js
// Force Google + Cloudflare DNS servers
dns.setServers(["8.8.8.8", "8.8.4.4", "1.1.1.1", "1.0.0.1"]);

// Connection event listeners
mongoose.connection.on("connected", () => {
  logger.info("Mongoose connected to DB");
  global.lastDbError = null;
});

mongoose.connection.on("disconnected", () => {
  logger.warn("Mongoose disconnected from DB");
});

mongoose.connection.on("error", (err) => {
  logger.error("Mongoose connection error:", err.message);
  global.lastDbError = err.message;
});

exports.dbConnect = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      // Connection pooling - CRITICAL for cluster mode (4 PM2 instances)
      maxPoolSize: 10, // Max 10 connections per instance (4 × 10 = 40 total)
      minPoolSize: 2, // Maintain at least 2 connections

      // Timeout settings
      serverSelectionTimeoutMS: 15000, // Timeout after 15s if can't connect
      socketTimeoutMS: 45000, // Close sockets after 45s inactivity
      heartbeatFrequencyMS: 10000, // Check server health every 10s

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

