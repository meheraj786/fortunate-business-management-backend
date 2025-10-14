const jwt = require("jsonwebtoken");
const User = require("../models/user.model");
const { ApiError } = require("../utils/ApiError");

const authMiddleware = async (req, _, next) => {
  try {
    const token = req.cookies.accessToken;

    if (!token) {
      return next(new ApiError(401, "Unauthorized: No token found"));
    }

    const decoded = jwt.verify(token, process.env.SECRET_KEY);

    const user = await User.findById(decoded._id).select("-password");
    if (!user) {
      return next(new ApiError(404, "User not found"));
    }

    req.user = user;
    next();
  } catch (error) {
    next(new ApiError(401, "Invalid or expired token", [error.message]));
  }
};

module.exports = { authMiddleware };
