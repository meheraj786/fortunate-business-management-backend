const jwt = require("jsonwebtoken");
const User = require("../models/user.model");
const logger = require("../utils/logger");

exports.authenticate = async (req, res, next) => {
  try {
    let token = req.cookies?.accessToken;

    if (
      !token &&
      req.headers.authorization &&
      req.headers.authorization.startsWith("Bearer")
    ) {
      token = req.headers.authorization.split(" ")[1];
    }

    if (!token) {
      return res.status(401).json({ message: "No token provided" });
    }

    const decoded = jwt.verify(token, process.env.SECRET_KEY);

    // OPTIMIZATION: Select only needed fields and use .lean() for faster queries
    // Include lastLogoutAt for token revocation check
    const user = await User.findById(decoded._id)
      .select("_id name email roleName access warehouse isDeleted +lastLogoutAt")
      .lean();

    if (!user || user.isDeleted) {
      return res.status(401).json({ message: "User not found or access denied" });
    }

    // SEC-1: Token revocation check — reject tokens issued before last logout
    if (user.lastLogoutAt && decoded.iat < Math.floor(user.lastLogoutAt.getTime() / 1000)) {
      return res.status(401).json({ message: "Session expired. Please log in again." });
    }

    req.user = user;
    next();
  } catch (err) {
    logger.error("Auth error:", err);
    res.status(401).json({ message: "Unauthorized" });
  }
};
