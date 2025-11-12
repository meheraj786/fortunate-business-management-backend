const User = require("../models/user.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const jwt = require("jsonwebtoken");

const registerUser = async (req, res, next) => {
  try {
    const { name, email, password } = req.body;

    const validationErrors = [];
    if (!name)
      validationErrors.push({ field: "name", message: "Name is required" });
    if (!email)
      validationErrors.push({ field: "email", message: "Email is required" });
    if (!password)
      validationErrors.push({
        field: "password",
        message: "Password is required",
      });

    if (validationErrors.length > 0) {
      return next(new ApiError(400, "Validation failed", validationErrors));
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return next(
        new ApiError(409, "User already exists", [
          {
            field: "email",
            message: "User already exists with this email",
          },
        ])
      );
    }

    const user = new User(req.body);
    await user.save();

    return res
      .status(201)
      .json(new ApiResponse(201, user, "User registered successfully"));
  } catch (error) {
    next(new ApiError(500, "Registration failed", [error.message]));
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
      return next(new ApiError(400, "Validation failed", validationErrors));
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

    res.cookie("accessToken", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
    });

    return res
      .status(200)
      .json(new ApiResponse(200, { user, token }, "Logged in successfully"));
  } catch (error) {
    console.log(error);

    next(new ApiError(500, "Login failed", [error.message]));
  }
};
const logoutUser = async (_, res, next) => {
  try {
    res.clearCookie("accessToken", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
    });

    return res.status(200).json(new ApiResponse(200, {}, "Logged out successfully"));
  } catch (error) {
    next(new ApiError(500, "Logout failed", [error.message]));
  }
};

const getUser = async (req, res, next) => {
  try {
    const fetchedUser = await User.findById(req.params.id).populate(
      "warehouse"
    );
    if (!fetchedUser) {
      return next(new ApiError(404, "User not found"));
    }

    return res
      .status(200)
      .json(new ApiResponse(200, fetchedUser, "Profile fetched successfully"));
  } catch (error) {
    next(new ApiError(500, "Failed to fetch profile", [error.message]));
  }
};
const getProfile = async (req, res, next) => {
  try {
    const fetchedUser = await User.findById(req.user._id).populate("warehouse");
    if (!fetchedUser) {
      return next(new ApiError(404, "User not found"));
    }

    return res
      .status(200)
      .json(new ApiResponse(200, fetchedUser, "Profile fetched successfully"));
  } catch (error) {
    next(new ApiError(500, "Failed to fetch profile", [error.message]));
  }
};
const getAllUser = async (req, res, next) => {
  try {
    const fetchedUser = await User.find({}).populate("warehouse");
    if (!fetchedUser) {
      return next(new ApiError(404, "User not found"));
    }
    return res
      .status(200)
      .json(new ApiResponse(200, fetchedUser, "Profile fetched successfully"));
  } catch (error) {
    next(new ApiError(500, "Failed to fetch profile", [error.message]));
  }
};

module.exports = {
  registerUser,
  loginUser,
  getProfile,
  logoutUser,
  getAllUser,
  getUser,
};
