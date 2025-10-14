const User = require("../models/user.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const jwt = require("jsonwebtoken");

const registerUser = async (req, res, next) => {
  try {
    const { name, email, password, access, warehouse } = req.body;

    if (!name || !email || !password) {
      return next(new ApiError(400, "All fields are required"));
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return next(new ApiError(409, "User already exists with this email"));
    }

    const user = new User({
      name,
      email,
      password,
      access,
    });
    await user.save();

    return res
      .status(201)
      .json(new ApiResponse(user, "User registered successfully"));
  } catch (error) {
    next(new ApiError(500, "Registration failed", [error.message]));
  }
};

const loginUser = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return next(new ApiError(400, "Email and password are required"));
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
      secure: "production",
      sameSite: "strict",
    });

    return res
      .status(200)
      .json(new ApiResponse({ user }, "Logged in successfully"));
  } catch (error) {
    console.log(error);
    
    next(new ApiError(500, "Login failed", [error.message]));
  }
};
const logoutUser = async (req, res, next) => {
  try {
    res.clearCookie("accessToken", {
      httpOnly: true,
      secure: "production",
      sameSite: "strict",
    });

    return res.status(200).json(new ApiResponse({}, "Logged out successfully"));
  } catch (error) {
    next(new ApiError(500, "Logout failed", [error.message]));
  }
};

const getProfile = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).populate("warehouse");
    if (!user) {
      return next(new ApiError(404, "User not found"));
    }

    return res
      .status(200)
      .json(new ApiResponse(user, "Profile fetched successfully"));
  } catch (error) {
    next(new ApiError(500, "Failed to fetch profile", [error.message]));
  }
};


module.exports = {
  registerUser,
  loginUser,
  getProfile,
  logoutUser,
};
