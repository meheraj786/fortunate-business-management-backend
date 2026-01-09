const express = require("express");
const {
  registerUser,
  loginUser,
  logoutUser,
  getProfile,
  getAllUser,
  getUser,
  updateUser,
  deleteUser,
} = require("../../controllers/user.controller");
const { authenticate } = require("../../middleware/auth.middleware");
const {
  authorize,
  authorizeRole,
} = require("../../middleware/authorize.middleware");
const { PERMISSIONS } = require("../../utils/permissions.constants");
const userRoutes = express.Router();

userRoutes.post(
  "/create-user",
  authenticate,
  authorize(PERMISSIONS.USER_CREATE),
  registerUser
);
userRoutes.post("/login", loginUser);
userRoutes.post("/logout", logoutUser);
userRoutes.get("/get-profile", authenticate, getProfile);
userRoutes.patch(
  "/update-user/:id",
  authenticate,
  authorizeRole("SUPER_ADMIN"),
  updateUser
);
userRoutes.get(
  "/get-users",
  authenticate,
  authorizeRole("SUPER_ADMIN"),
  getAllUser
);
userRoutes.get(
  "/get-user/:id",
  authenticate,
  authorizeRole("SUPER_ADMIN"),
  getUser
);
userRoutes.delete(
  "/delete-user/:id",
  authenticate,
  authorizeRole("SUPER_ADMIN"),
  deleteUser
);

module.exports = userRoutes;
