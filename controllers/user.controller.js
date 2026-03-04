const User = require("../models/user.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const logger = require("../utils/logger");
const { now } = require("../utils/timezone.util");
const {
  BUNDLED_PERMISSIONS,
  PERMISSIONS,
} = require("../utils/permissions.constants");
const Trash = require("../models/trash.model");
const auditService = require("../services/audit.service");
const RefreshToken = require("../models/refreshToken.model");

// Shared cookie option builder
const getAccessCookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  maxAge: 15 * 60 * 1000, // 15 minutes — matches JWT expiry
});

const getRefreshCookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
});

const registerUser = async (req, res, next) => {
  try {
    const user = new User(req.body);

    // Ensure access array exists
    if (!user.access) {
      user.access = [];
    }

    // Set createdBy if a user is logged in (e.g. admin creating a user)
    if (req.user) {
      user.createdBy = req.user._id;
    }

    // Add CATEGORY_VIEW permission
    const categoryModule = "CATEGORY";
    const categoryViewPermission = PERMISSIONS.CATEGORY_VIEW;
    let categoryAccess = user.access.find((a) => a.module === categoryModule);
    if (categoryAccess) {
      if (!categoryAccess.permissions.includes(categoryViewPermission)) {
        categoryAccess.permissions.push(categoryViewPermission);
      }
    } else {
      user.access.push({
        module: categoryModule,
        permissions: [categoryViewPermission],
      });
    }

    // Add UNIT_VIEW permission
    const unitModule = "UNIT";
    const unitViewPermission = PERMISSIONS.UNIT_VIEW;
    let unitAccess = user.access.find((a) => a.module === unitModule);
    if (unitAccess) {
      if (!unitAccess.permissions.includes(unitViewPermission)) {
        unitAccess.permissions.push(unitViewPermission);
      }
    } else {
      user.access.push({
        module: unitModule,
        permissions: [unitViewPermission],
      });
    }

    // Apply bundled permissions (auto-include prerequisites)
    user.access = user.access.map((module) => {
      let permissions = new Set(module.permissions || []);
      (module.permissions || []).forEach((p) => {
        const bundled = BUNDLED_PERMISSIONS[p];
        if (bundled) {
          bundled.forEach((bp) => permissions.add(bp));
        }
      });
      return { module: module.module, permissions: Array.from(permissions) };
    });

    await user.save();

    auditService.log({
      action: "CREATE",
      module: "User",
      documentId: user._id,
      userId: req.user?._id,
      description: `Created user ${user.name} (${user.email})`,
      req,
    });

    return res
      .status(201)
      .json(new ApiResponse(201, user, "User registered successfully"));
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A user with the same ${field} '${value}' already exists.`,
        ),
      ); // Specific message for user
    }
    // Handle Mongoose validation errors
    if (error.name === "ValidationError") {
      const firstErrorField = Object.keys(error.errors)[0];
      let userFriendlyMessage = "Validation failed.";

      if (firstErrorField) {
        userFriendlyMessage = error.errors[firstErrorField].message || `The field ${firstErrorField} is invalid.`;
      }
      return next(new ApiError(400, userFriendlyMessage, error.errors));
    }
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
};

const loginUser = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const validationErrors = [];
    if (!email)
      validationErrors.push({ field: "email", message: "Email is required" });
    if (!password)
      validationErrors.push({
        field: "password",
        message: "Password is required",
      });

    if (validationErrors.length > 0) {
      return next(
        new ApiError(400, validationErrors[0].message, validationErrors),
      );
    }

    const user = await User.findOne({ email, isDeleted: { $ne: true } }).select("+password");
    if (!user) {
      return next(new ApiError(401, "Invalid email or password"));
    }

    const isValid = await user.isPasswordCorrect(password);
    if (!isValid) {
      return next(new ApiError(401, "Invalid email or password"));
    }

    const accessToken = user.generateToken();

    // Generate refresh token (random + secure)
    const refreshTokenStr = crypto.randomBytes(40).toString("hex");
    await RefreshToken.create({
      token: refreshTokenStr,
      userId: user._id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    });

    // Convert to plain object and strip password hash before sending response
    const userObj = user.toObject();
    delete userObj.password;

    res.cookie("accessToken", accessToken, getAccessCookieOptions());
    res.cookie("refreshToken", refreshTokenStr, getRefreshCookieOptions());

    // Audit: Login
    auditService.log({ action: "LOGIN", module: "User", documentId: user._id, userId: user._id, description: `User ${user.name} (${user.email}) logged in`, req });

    return res
      .status(200)
      .json(new ApiResponse(200, userObj, "Logged in successfully"));
  } catch (error) {
    logger.error(error);
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A user with the same ${field} '${value}' already exists.`,
        ),
      ); // Specific message for user
    }
    // Handle Mongoose validation errors
    if (error.name === "ValidationError") {
      const firstErrorField = Object.keys(error.errors)[0];
      let userFriendlyMessage = "Validation failed.";

      if (firstErrorField) {
        userFriendlyMessage = error.errors[firstErrorField].message || `The field ${firstErrorField} is invalid.`;
      }
      return next(new ApiError(400, userFriendlyMessage, error.errors));
    }
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
};
const logoutUser = async (req, res, next) => {
  try {
    // Clear access token cookie
    res.clearCookie("accessToken", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
    });

    // Clear refresh token cookie
    res.clearCookie("refreshToken", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
    });

    // Delete refresh token from DB + invalidate all access tokens issued before now
    if (req.user?._id) {
      await Promise.all([
        RefreshToken.deleteMany({ userId: req.user._id }),
        User.findByIdAndUpdate(req.user._id, { lastLogoutAt: new Date() }),
      ]);
    }

    // Audit: Logout
    auditService.log({ action: "LOGOUT", module: "User", documentId: req.user?._id, userId: req.user?._id, description: `User ${req.user?.name || "Unknown"} logged out`, req });

    return res
      .status(200)
      .json(new ApiResponse(200, {}, "Logged out successfully"));
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
};

const refreshTokenHandler = async (req, res, next) => {
  try {
    const incomingRefreshToken = req.cookies?.refreshToken;

    if (!incomingRefreshToken) {
      return next(new ApiError(401, "No refresh token provided"));
    }

    // Find and delete the incoming refresh token (single-use / rotation)
    const storedToken = await RefreshToken.findOneAndDelete({ token: incomingRefreshToken });

    if (!storedToken) {
      // Token not found — it may have been used already (replay attack) or expired
      // As a security measure, invalidate ALL refresh tokens for this user
      // We can't know the userId here since the token is invalid, so just reject
      return next(new ApiError(401, "Invalid or expired refresh token. Please log in again."));
    }

    // Check if the token has expired (belt + suspenders with TTL)
    if (storedToken.expiresAt < new Date()) {
      return next(new ApiError(401, "Refresh token expired. Please log in again."));
    }

    // Find the user
    const user = await User.findById(storedToken.userId);
    if (!user || user.isDeleted) {
      return next(new ApiError(401, "User not found or access denied"));
    }

    // Generate new access token
    const newAccessToken = user.generateToken();

    // Generate new refresh token (token rotation)
    const newRefreshTokenStr = crypto.randomBytes(40).toString("hex");
    await RefreshToken.create({
      token: newRefreshTokenStr,
      userId: user._id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    });

    // Set new cookies
    res.cookie("accessToken", newAccessToken, getAccessCookieOptions());
    res.cookie("refreshToken", newRefreshTokenStr, getRefreshCookieOptions());

    return res
      .status(200)
      .json(new ApiResponse(200, {}, "Token refreshed successfully"));
  } catch (error) {
    logger.error("RefreshToken Error:", error);
    if (error instanceof ApiError) {
      return next(error);
    }
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
};

const getUser = async (req, res, next) => {
  try {
    const fetchedUser = await User.findById(req.params.id)
      .populate("warehouse")
      .populate("createdBy", "name email")
      .populate("modifiedBy", "name email")
      .populate("deletedBy", "name email")
      .lean();
    if (!fetchedUser || fetchedUser.isDeleted) {
      return next(new ApiError(404, "User not found"));
    }

    return res
      .status(200)
      .json(new ApiResponse(200, fetchedUser, "Profile fetched successfully"));
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A user with the same ${field} '${value}' already exists.`,
        ),
      ); // Specific message for user
    }
    // Handle Mongoose validation errors
    if (error.name === "ValidationError") {
      const firstErrorField = Object.keys(error.errors)[0];
      let userFriendlyMessage = "Validation failed.";

      if (firstErrorField) {
        userFriendlyMessage = error.errors[firstErrorField].message || `The field ${firstErrorField} is invalid.`;
      }
      return next(new ApiError(400, userFriendlyMessage, error.errors));
    }
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
};
const getProfile = async (req, res, next) => {
  try {
    const fetchedUser = await User.findById(req.user._id)
      .populate("warehouse")
      .lean();
    if (!fetchedUser || fetchedUser.isDeleted) {
      return next(new ApiError(404, "User not found"));
    }

    return res
      .status(200)
      .json(new ApiResponse(200, fetchedUser, "Profile fetched successfully"));
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A user with the same ${field} '${value}' already exists.`,
        ),
      ); // Specific message for user
    }
    // Handle Mongoose validation errors
    if (error.name === "ValidationError") {
      const firstErrorField = Object.keys(error.errors)[0];
      let userFriendlyMessage = "Validation failed.";

      if (firstErrorField) {
        userFriendlyMessage = error.errors[firstErrorField].message || `The field ${firstErrorField} is invalid.`;
      }
      return next(new ApiError(400, userFriendlyMessage, error.errors));
    }
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
};
const getAllUser = async (req, res, next) => {
  try {
    const fetchedUser = await User.find({ isDeleted: false })
      .populate("warehouse")
      .lean();

    if (fetchedUser.length === 0) {
      return next(new ApiError(404, "No users found"));
    }
    return res
      .status(200)
      .json(new ApiResponse(200, fetchedUser, "Profile fetched successfully"));
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A user with the same ${field} '${value}' already exists.`,
        ),
      ); // Specific message for user
    }
    // Handle Mongoose validation errors
    if (error.name === "ValidationError") {
      const firstErrorField = Object.keys(error.errors)[0];
      let userFriendlyMessage = "Validation failed.";

      if (firstErrorField) {
        userFriendlyMessage = error.errors[firstErrorField].message || `The field ${firstErrorField} is invalid.`;
      }
      return next(new ApiError(400, userFriendlyMessage, error.errors));
    }
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
};

const updateUser = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    if (req.user.roleName !== "SUPER_ADMIN" && req.user.roleName !== "ADMIN") {
      return next(new ApiError(403, "You are not authorized to update users"));
    }

    const user = await User.findById(id);
    if (!user) {
      return next(new ApiError(404, "User not found"));
    }

    if (updates.password) {
      updates.password = await bcrypt.hash(updates.password, 10);
    }

    // Handle the new, more granular access structure
    if (updates.access && Array.isArray(updates.access)) {
      updates.access = updates.access.map((module) => {
        // Start with the permissions explicitly given for the module
        let permissions = new Set(module.permissions || []);

        // Automatically add bundled permissions
        (module.permissions || []).forEach((p) => {
          const bundled = BUNDLED_PERMISSIONS[p];
          if (bundled) {
            bundled.forEach((bundledPermission) =>
              permissions.add(bundledPermission),
            );
          }
        });

        return {
          module: module.module,
          permissions: Array.from(permissions), // Convert Set back to Array
        };
      });
    }

    // Only allow updating specific fields (allowlist)
    const allowedFields = ['name', 'email', 'phone', 'roleName', 'description', 'location', 'address', 'access', 'warehouse', 'password', 'avatar'];
    Object.keys(updates).forEach((key) => {
      if (allowedFields.includes(key)) {
        user[key] = updates[key];
      }
    });

    user.modifiedBy = req.user._id;

    await user.save();

    const updatedUser = await User.findById(id).populate("warehouse");

    // Audit: User updated
    auditService.log({ action: "UPDATE", module: "User", documentId: id, userId: req.user?._id, description: `Updated user ${updatedUser.name} (${updatedUser.email})`, changes: auditService.diffChanges(user, updatedUser, ["name", "email", "phone", "roleName", "description", "location", "address"]), req });

    return res
      .status(200)
      .json(new ApiResponse(200, updatedUser, "User updated successfully"));
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A user with the same ${field} '${value}' already exists.`,
        ),
      ); // Specific message for user
    }
    // Handle Mongoose validation errors
    if (error.name === "ValidationError") {
      const firstErrorField = Object.keys(error.errors)[0];
      let userFriendlyMessage = "Validation failed.";

      if (firstErrorField) {
        userFriendlyMessage = error.errors[firstErrorField].message || `The field ${firstErrorField} is invalid.`;
      }
      return next(new ApiError(400, userFriendlyMessage, error.errors));
    }
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
};

const deleteUser = async (req, res, next) => {
  try {
    const { id } = req.params;
    const deletedBy = req.user?._id || null;

    // Prevent self-deletion
    if (id === req.user?._id?.toString()) {
      return next(new ApiError(400, "You cannot delete your own account."));
    }

    // Check if the target user is a SUPER_ADMIN
    const targetUser = await User.findById(id);
    if (!targetUser) {
      return next(new ApiError(404, "User not found"));
    }
    if (targetUser.roleName === "SUPER_ADMIN") {
      return next(new ApiError(403, "The SUPER_ADMIN account cannot be deleted."));
    }

    const deletedUser = await User.findByIdAndUpdate(
      id,
      { isDeleted: true, deletedBy },
      { new: true },
    );
    if (!deletedUser) {
      return next(new ApiError(404, "User not found"));
    }
    // move to trash
    await Trash.create({
      docId: deletedUser._id,
      model: "User",
      deletedBy,
      deletedAt: now(),
    });
    // Audit: User deleted
    auditService.log({ action: "DELETE", module: "User", documentId: deletedUser._id, userId: deletedBy, description: `Deleted user ${deletedUser.name} (${deletedUser.email})`, req });

    return res
      .status(200)
      .json(
        new ApiResponse(200, deletedUser, "User moved to trash successfully"),
      );
  } catch (error) {
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
};

module.exports = {
  registerUser,
  loginUser,
  getProfile,
  logoutUser,
  getAllUser,
  getUser,
  updateUser,
  deleteUser,
  refreshTokenHandler,
};
