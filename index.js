// Set the default timezone for the application
process.env.TZ = "Asia/Dhaka";

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
const routers = require("./routes"); // All routes
const { ApiError } = require("./utils/ApiError"); // Custom API error
const logger = require("./utils/logger"); // Logger
const {
  autoCloseDailyCashForCron,
  closeMissedDailyCashEntries,
} = require("./controllers/dailyCash.controller"); // Cron controllers
const { initBackupJob } = require("./services/backupScheduler.service"); // Backup controller
const { attachTimezone } = require("./middleware/timezone.middleware"); // Timezone middleware
const { checkDbStatus } = require("./middleware/dbStatus.middleware"); // DB status middleware

// Create express app
const app = express(); // Initialize express app

// Configure CORS
const allowedOrigins = [];
if (process.env.NODE_ENV === "production") {
  if (process.env.CORS_ORIGIN) {
    allowedOrigins.push(process.env.CORS_ORIGIN);
  }
} else {
  // In development, allow any localhost origin
}

app.use(
  cors({
    origin: (origin, callback) => {
      // In development, allow requests from any localhost port
      if (
        process.env.NODE_ENV !== "production" &&
        origin &&
        origin.startsWith("http://localhost")
      ) {
        return callback(null, true);
      }

      // In production, check against the configured origin
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      // Block other origins
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true, // Allow cookies
  }),
);

// Security middlewares
app.use(helmet()); // Add security headers
app.use(express.json({ limit: "2mb" })); // Parse JSON body with size limit
app.use(express.urlencoded({ extended: true })); // Parse URL encoded body
app.use(cookieParser()); // Parse cookies

// Enable compression
app.use(
  compression({
    level: 6, // Compression level
    threshold: 1024, // Minimum size
  }),
);

// Rate limiting
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute window
  max: 500, // Max requests
  message: "Too many requests!!", // Message
});
app.use(limiter);

// Attach timezone to all requests (must be before routes)
app.use(attachTimezone);

// Check database status before processing routes
app.use(checkDbStatus);

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
    responsePayload.debug = err.debug; // Only expose debug info in dev
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
    // Puppeteer is lazily initialized on first PDF request via getBrowser() singleton
    await closeMissedDailyCashEntries(); // Fix missed cash entries
    logger.info("Background startup tasks completed"); // Log success
  } catch (error) {
    logger.error("Startup task failed:", error); // Log error
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
  },
);

// Backup Cron Job (runs daily at 02:00)
// Initialize dynamic backup job
initBackupJob();
