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
