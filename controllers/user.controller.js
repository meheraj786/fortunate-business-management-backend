const User = require("../models/user.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const logger = require("../utils/logger");
const { now } = require("../utils/timezone.util");
const {
  BUNDLED_PERMISSIONS,
  PERMISSIONS,
} = require("../utils/permissions.constants");
const Trash = require("../models/trash.model");

const registerUser = async (req, res, next) => {
  try {
    // Strip roleName from body to prevent self-role-assignment
    delete req.body.roleName;
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
    await user.save();

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
        userFriendlyMessage = `The field ${firstErrorField} is required.`;
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

    const user = await User.findOne({ email }).select("+password");
    if (!user) {
      return next(new ApiError(404, "User not found"));
    }

    const isValid = await user.isPasswordCorrect(password);
    if (!isValid) {
      return next(new ApiError(401, "Invalid credentials"));
    }

    const token = user.generateToken();

    // Convert to plain object and strip password hash before sending response
    const userObj = user.toObject();
    delete userObj.password;

    const cookieOptions = {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    };

    res.cookie("accessToken", token, cookieOptions);

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
        userFriendlyMessage = `The field ${firstErrorField} is required.`;
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
const logoutUser = async (_, res, next) => {
  try {
    const cookieOptions = {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    };

    res.clearCookie("accessToken", cookieOptions);

    return res
      .status(200)
      .json(new ApiResponse(200, {}, "Logged out successfully"));
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
        userFriendlyMessage = `The field ${firstErrorField} is required.`;
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

const getUser = async (req, res, next) => {
  try {
    const fetchedUser = await User.findById(req.params.id)
      .populate("warehouse")
      .populate("createdBy", "name email")
      .populate("modifiedBy", "name email")
      .populate("deletedBy", "name email");
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
        userFriendlyMessage = `The field ${firstErrorField} is required.`;
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
      .populate("createdBy", "name email")
      .populate("modifiedBy", "name email")
      .populate("deletedBy", "name email");
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
        userFriendlyMessage = `The field ${firstErrorField} is required.`;
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
    const fetchedUser = await User.aggregate([
      {
        $match: {
          isDeleted: false,
        },
      },
      {
        $lookup: {
          from: "warehouses",
          localField: "warehouse",
          foreignField: "_id",
          as: "warehouse",
        },
      },
    ]);

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
        userFriendlyMessage = `The field ${firstErrorField} is required.`;
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
    const allowedFields = ['name', 'email', 'phone', 'roleName', 'description', 'location', 'access', 'warehouse', 'password', 'avatar'];
    Object.keys(updates).forEach((key) => {
      if (allowedFields.includes(key)) {
        user[key] = updates[key];
      }
    });

    user.modifiedBy = req.user._id;

    await user.save();

    const updatedUser = await User.findById(id).populate("warehouse");

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
        userFriendlyMessage = `The field ${firstErrorField} is required.`;
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
};
