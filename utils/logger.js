const winston = require("winston");
const path = require("path");

const { combine, timestamp, printf, colorize, align } = winston.format;

const logFormat = printf(({ level, message, timestamp }) => {
  return `${timestamp} ${level}: ${message}`;
});

const developmentLogger = () => {
  return winston.createLogger({
    level: "debug",
    format: combine(
      colorize(),
      timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
      align(),
      logFormat
    ),
    transports: [new winston.transports.Console()],
  });
};

// Keep a reference to the console transport so we can add/remove it dynamically
let prodConsoleTransport = new winston.transports.Console({
  level: "error",
  format: combine(
    colorize(),
    timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    align(),
    logFormat
  ),
});

const productionLogger = () => {
  return winston.createLogger({
    level: "info",
    format: combine(
      timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
      align(),
      logFormat
    ),
    transports: [
      new winston.transports.File({
        filename: path.join(__dirname, "..", "logs", "app-error.log"),
        level: "error",
      }),
      new winston.transports.File({
        filename: path.join(__dirname, "..", "logs", "app-combined.log"),
      }),
      prodConsoleTransport, // IMP-5: Console transport enabled by default
    ],
    exceptionHandlers: [
      new winston.transports.File({ filename: path.join(__dirname, "..", "logs", "exceptions.log") })
    ],
    rejectionHandlers: [
      new winston.transports.File({ filename: path.join(__dirname, "..", "logs", "rejections.log") })
    ]
  });
};

const logger =
  process.env.NODE_ENV === "production"
    ? productionLogger()
    : developmentLogger();

/**
 * Dynamically reload the production console transport.
 * Called when logging settings are updated from the frontend.
 * @param {boolean} enabled - Whether the console transport should be active
 * @param {string} level - Log level for the console transport (error, warn, info, debug)
 */
function reloadConsoleTransport(enabled, level) {
  if (process.env.NODE_ENV !== "production") return; // Dev always has console

  try {
    // Remove the existing console transport if present
    logger.remove(prodConsoleTransport);
  } catch {
    // Transport wasn't attached — that's fine
  }

  if (enabled) {
    prodConsoleTransport = new winston.transports.Console({
      level: level || "error",
      format: combine(
        colorize(),
        timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
        align(),
        logFormat
      ),
    });
    logger.add(prodConsoleTransport);
  }
}

module.exports = logger;
module.exports.reloadConsoleTransport = reloadConsoleTransport;
