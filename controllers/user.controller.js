const User = require("../models/user.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const jwt = require("jsonwebtoken");
const logger = require("../utils/logger");
const { now } = require("../utils/timezone.util");
const {
  BUNDLED_PERMISSIONS,
} = require("../utils/permissions.constants");
const Trash = require("../models/trash.model");

const registerUser = async (req, res, next) => {
  try {
    const user = new User(req.body);
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
          `A user with the same ${field} '${value}' already exists.`
        )
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
    next(new ApiError(500, "An unexpected error occurred. Please try again."));
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
        new ApiError(400, validationErrors[0].message, validationErrors)
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

    // Ensure password hash is not sent in the response
    delete user.password;

    res.cookie("accessToken", token, {
      httpOnly: true,
      secure: true, // Always true for sameSite: "none"
      sameSite: "none",
    });

    return res
      .status(200)
      .json(new ApiResponse(200, user, "Logged in successfully"));
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
          `A user with the same ${field} '${value}' already exists.`
        )
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
    next(new ApiError(500, "An unexpected error occurred. Please try again."));
  }
};
const logoutUser = async (_, res, next) => {
  try {
    res.clearCookie("accessToken", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "none",
    });

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
          `A user with the same ${field} '${value}' already exists.`
        )
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
    next(new ApiError(500, "An unexpected error occurred. Please try again."));
  }
};

const getUser = async (req, res, next) => {
  try {
    const fetchedUser = await User.findById(req.params.id).populate(
      "warehouse"
    );
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
          `A user with the same ${field} '${value}' already exists.`
        )
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
    next(new ApiError(500, "An unexpected error occurred. Please try again."));
  }
};
const getProfile = async (req, res, next) => {
  try {
    const fetchedUser = await User.findById(req.user._id).populate("warehouse");
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
          `A user with the same ${field} '${value}' already exists.`
        )
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
    next(new ApiError(500, "An unexpected error occurred. Please try again."));
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

    if (!fetchedUser) {
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
          `A user with the same ${field} '${value}' already exists.`
        )
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
    next(new ApiError(500, "An unexpected error occurred. Please try again."));
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
              permissions.add(bundledPermission)
            );
          }
        });

        return {
          module: module.module,
          permissions: Array.from(permissions), // Convert Set back to Array
        };
      });
    }

    Object.keys(updates).forEach((key) => {
      user[key] = updates[key];
    });

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
          `A user with the same ${field} '${value}' already exists.`
        )
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
    next(new ApiError(500, "An unexpected error occurred. Please try again."));
  }
};

const deleteUser = async (req, res, next) => {
  try {
    const { id } = req.params;
    const deletedBy = req.user?._id || null;
    const deletedUser = await User.findByIdAndUpdate(
      id,
      { isDeleted: true },
      { new: true }
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
        new ApiResponse(200, deletedUser, "User moved to trash successfully")
      );
  } catch (error) {
        logger.error(error);
    next(new ApiError(500, "An unexpected error occurred. Please try again."));
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
