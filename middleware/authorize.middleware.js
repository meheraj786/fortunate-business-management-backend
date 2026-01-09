const authorizeRole = (requiredRole) => (req, res, next) => {
  try {
    const user = req.user;

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized - No user logged in.",
      });
    }

    if (user.roleName === "SUPER_ADMIN") {
      return next(); // SUPER_ADMIN bypasses all role checks
    }

    if (user.roleName !== requiredRole) {
      return res.status(403).json({
        success: false,
        message: `Forbidden - Requires ${requiredRole} role.`,
      });
    }

    next();
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Authorization failed during role check.",
    });
  }
};

const authorize = (requiredPermission) => (req, res, next) => {
  try {
    const user = req.user;

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    // Admins have all permissions
    if (user.roleName === "ADMIN" || user.roleName === "SUPER_ADMIN") {
      return next();
    }

    if (!user.access || user.access.length === 0) {
      return res.status(403).json({
        success: false,
        message: "Forbidden - You have no assigned permissions.",
      });
    }

    // Create a set of all permissions the user has for quick lookups.
    const userPermissions = new Set();
    user.access.forEach((module) => {
      module.permissions.forEach((p) => userPermissions.add(p));
    });

    if (!userPermissions.has(requiredPermission)) {
      return res.status(403).json({
        success: false,
        message: `Forbidden - You don't have the required '${requiredPermission}' permission.`,
      });
    }

    next();
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Authorization failed during permission check.",
    });
  }
};

const authorizeWarehouseAccess = (requiredPermission) => (req, res, next) => {
  try {
    const user = req.user;

    const { warehouseId } = req.params;

    if (!user) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    // SUPER_ADMIN and ADMIN bypass all checks

    if (user.roleName === "ADMIN" || user.roleName === "SUPER_ADMIN") {
      return next();
    }

    // 1. Check if user has access to this specific warehouse

    const hasWarehouseAccess = user.warehouse.some(
      (wh) => wh.toString() === warehouseId
    );

    if (!hasWarehouseAccess) {
      return res.status(403).json({
        success: false,

        message: "Forbidden - You do not have access to this warehouse.",
      });
    }

    // 2. Check if user has the required permission for the action

    if (requiredPermission) {
      const userPermissions = new Set();

      user.access.forEach((module) => {
        module.permissions.forEach((p) => userPermissions.add(p));
      });

      if (!userPermissions.has(requiredPermission)) {
        return res.status(403).json({
          success: false,

          message: `Forbidden - You don't have the required '${requiredPermission}' permission.`,
        });
      }
    }

    next();
  } catch (error) {
    return res.status(500).json({
      success: false,

      message: "Authorization failed during warehouse access check.",
    });
  }
};

const authorizeTrashAccess = (action) => (req, res, next) => {
  try {
    const user = req.user;

    const { model } = req.params;

    if (!user) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    if (!model) {
      return res

        .status(400)

        .json({ success: false, message: "Model parameter is required." });
    }

    if (user.roleName === "ADMIN" || user.roleName === "SUPER_ADMIN") {
      return next();
    }

    // Construct the permission string dynamically, e.g., TRASH_VIEW_LC

    const requiredPermission = `TRASH_${action}_${model.toUpperCase()}`;

    const userPermissions = new Set();

    user.access.forEach((module) => {
      module.permissions.forEach((p) => userPermissions.add(p));
    });

    if (!userPermissions.has(requiredPermission)) {
      return res.status(403).json({
        success: false,

        message: `Forbidden - You don't have the required '${requiredPermission}' permission.`,
      });
    }

    next();
  } catch (error) {
    return res.status(500).json({
      success: false,

      message: "Authorization failed during trash access check.",
    });
  }
};

module.exports = {
  authorize,

  authorizeRole,

  authorizeWarehouseAccess,

  authorizeTrashAccess,
};
