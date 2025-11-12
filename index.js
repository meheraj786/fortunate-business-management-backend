require("dotenv").config();
const express = require("express");
const compression = require("compression");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { dbConnect } = require("./database/db.config");
const { ApiError } = require("./utils/ApiError");
const routers = require("./routes");
const cookieParser = require("cookie-parser");

const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN }));
app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  compression({
    level: 6,
    threshold: 1024,
  })
);


const limiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 50,
  message: "Too many requests!!",
});
app.use(limiter);

(async () => {
  try {
    app.use(cookieParser());
    await dbConnect();
    app.use(routers);

    // Custom error handling middleware. This MUST be the last middleware.
    app.use((err, req, res, next) => {
      // Determine the status code, defaulting to 500 for unexpected errors
      const statusCode = err.statusCode || 500;

      // Prepare the base response payload
      const responsePayload = {
        success: false,
        message: err.message || "Something went wrong",
        errors: err.errors || [],
      };

      // Log unexpected errors to the console (ApiErrors are typically logged by the caller or not considered "unexpected")
      if (!(err instanceof ApiError)) {
        console.error(err);
      }

      // Conditionally add the stack trace if in development environment
      // Ensure process.env.NODE_ENV is set to 'development' in your .env file for this to take effect
      if (process.env.NODE_ENV === 'development') {
        responsePayload.stack = err.stack;
      }

      // Send the JSON response
      return res.status(statusCode).json(responsePayload);
    });

    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
  } catch (error) {
    console.error("Server failed to start:", error.message);
  }
})();
