// Load environment variables from .env file
require("dotenv").config(); // Load env variables

// Import core packages
const express = require("express"); // Express framework
const compression = require("compression"); // Compress responses
const helmet = require("helmet"); // Security headers
const cors = require("cors"); // CORS handling
const rateLimit = require("express-rate-limit"); // Rate limiting
const cookieParser = require("cookie-parser"); // Cookie parsing
const cron = require("node-cron"); // Cron jobs

// Import local modules
const { dbConnect } = require("./database/db.config"); // Database connection
const { getBrowser } = require("./utils/browserManager"); // Browser manager
const routers = require("./routes"); // All routes
const { ApiError } = require("./utils/ApiError"); // Custom API error
const logger = require("./utils/logger"); // Logger
const {
  autoCloseDailyCashForCron,
  closeMissedDailyCashEntries,
} = require("./controllers/dailyCash.controller"); // Cron controllers

// Create express app
const app = express(); // Initialize express app

// Enable CORS
app.use(
  cors({
    origin: process.env.CORS_ORIGIN, // Allowed origin
    credentials: true, // Allow cookies
  })
);

// Security middlewares
app.use(helmet()); // Add security headers
app.use(express.json()); // Parse JSON body
app.use(express.urlencoded({ extended: true })); // Parse URL encoded body
app.use(cookieParser()); // Parse cookies

// Enable compression
app.use(
  compression({
    level: 6, // Compression level
    threshold: 1024, // Minimum size
  })
);

// Rate limiting
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute window
  max: 500, // Max requests
  message: "Too many requests!!", // Message
});
app.use(limiter);

// Register routes
app.use(routers); // Use all API routes

// Global error handler (must be last)
app.use((err, req, res, next) => {
  const statusCode = err.statusCode || 500; // Status code
  const responsePayload = {
    success: false,
    message: err.message || "Something went wrong",
    errors: err.errors || [],
  };

  if (!(err instanceof ApiError)) {
    logger.error(err.stack); // Log unexpected errors
  }

  if (process.env.NODE_ENV === "development") {
    responsePayload.stack = err.stack; // Show stack in dev
  }

  return res.status(statusCode).json(responsePayload); // Send response
});

// Start server FIRST
const PORT = process.env.PORT || 3000; // Read port from env

app.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}`); // Log server start
});

// Run heavy startup tasks AFTER server starts
(async () => {
  try {
    await dbConnect(); // Connect database
    await getBrowser(); // Start browser
    await closeMissedDailyCashEntries(); // Fix missed cash entries
    logger.info("Background startup tasks completed"); // Log success
  } catch (error) {
    logger.error("Startup task failed:", error.message); // Log error
  }
})();

// Cron job (runs daily at 23:59)
cron.schedule(
  "59 23 * * *",
  () => {
    logger.info("Running daily cash auto close job");
    autoCloseDailyCashForCron(); // Run cron task
  },
  {
    scheduled: true, // Enable cron
    timezone: "Asia/Dhaka", // Set timezone
  }
);
