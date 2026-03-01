const express = require("express");
const rateLimit = require("express-rate-limit");
const {
  registerUser,
  loginUser,
  logoutUser,
  getProfile,
  getAllUser,
  getUser,
  updateUser,
  deleteUser,
  refreshTokenHandler,
} = require("../../controllers/user.controller");
const { authenticate } = require("../../middleware/auth.middleware");
const {
  authorize,
} = require("../../middleware/authorize.middleware");
const { PERMISSIONS } = require("../../utils/permissions.constants");
const userRoutes = express.Router();

// SEC-4: Stricter rate limiter for login endpoint (brute-force protection)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15-minute window
  max: 10, // Max 10 attempts per window
  message: { message: "Too many login attempts. Please try again after 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});

userRoutes.post(
  "/create-user",
  authenticate,
  authorize(PERMISSIONS.USER_CREATE),
  registerUser
);
userRoutes.post("/login", loginLimiter, loginUser);
userRoutes.post("/refresh-token", refreshTokenHandler); // No auth — self-validates via refresh token
userRoutes.post("/logout", authenticate, logoutUser);
userRoutes.get("/get-profile", authenticate, getProfile);
userRoutes.patch(
  "/update-user/:id",
  authenticate,
  authorize(PERMISSIONS.USER_UPDATE),
  updateUser
);
userRoutes.get(
  "/get-users",
  authenticate,
  authorize(PERMISSIONS.USER_VIEW_ALL),
  getAllUser
);
userRoutes.get(
  "/get-user/:id",
  authenticate,
  authorize(PERMISSIONS.USER_VIEW_DETAILS),
  getUser
);
userRoutes.delete(
  "/delete-user/:id",
  authenticate,
  authorize(PERMISSIONS.USER_DELETE),
  deleteUser
);

module.exports = userRoutes;
