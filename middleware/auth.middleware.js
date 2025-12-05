const jwt = require("jsonwebtoken");
const User = require("../models/user.model");

exports.authMiddleware = async (req, res, next) => {
  try {
    const token = req.cookies?.accessToken;
    console.log(req.cookies);

    if (!token) {
      return res.status(401).json({ message: "No token provided" });
    }

    const decoded = jwt.verify(token, process.env.SECRET_KEY);
    const user = await User.findById(decoded._id);

    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }

    req.user = user;
    next();
  } catch (err) {
    console.error("Auth error:", err);
    res.status(401).json({ message: "Unauthorized" });
  }
};
