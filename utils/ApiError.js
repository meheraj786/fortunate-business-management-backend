class ApiError extends Error {
  constructor(
    statusCode,
    message = "Something went wrong",
    errors = [],
    debug = null,
    stack = "",
  ) {
    super(message);
    this.statusCode = statusCode;
    this.errors = errors;
    this.debug = debug; // Store technical details
    this.success = false;
    if (stack) {
      this.stack = stack;
    } else {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

module.exports = { ApiError };
