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

module.exports = logger;
