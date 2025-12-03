const authorize = (moduleName, permission) => (req, res, next) => {
  try {
    const user = req.user;

    if (!user || !user.access) {
      return res.status(403).json({
        success: false,
        message: "Access Denied",
      });
    }

    const moduleAccess = user.access.find((item) => item.module === moduleName);

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
