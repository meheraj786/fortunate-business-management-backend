const authorize = (moduleName, permission) => (req, res, next) => {
  try {
    const user = req.user;

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    if (user.roleName === "ADMIN" || user.roleName === "SUPER_ADMIN") {
      return next();
    }

    if (!user.access || user.access.length === 0) {
      return res.status(403).json({
        success: false,
        message: "No permissions assigned",
      });
    }

    const moduleAccess = user.access.find(
      (item) => item.module === moduleName
    );

    if (!moduleAccess) {
      return res.status(403).json({
        success: false,
        message: `No access to ${moduleName} module`,
      });
    }

    const hasPermission = moduleAccess.permissions.includes(permission);

    if (!hasPermission) {
      return res.status(403).json({
        success: false,
        message: `You don't have ${permission} permission`,
      });
    }

    next();
  } catch (error) {
    return res.status(403).json({
      success: false,
      message: "Authorization failed",
    });
  }
};

module.exports = authorize;
