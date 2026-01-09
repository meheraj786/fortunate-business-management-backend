const mongoose = require("mongoose");
const User = require("../models/user.model");
const logger = require("./logger");
const { PERMISSIONS, MODULES } = require("./permissions.constants");
require("dotenv").config();

// Dynamically create full access for all modules based on the constants
const fullAccess = MODULES.map((moduleName) => {
  const modulePermissions = Object.keys(PERMISSIONS).filter((p) =>
    p.startsWith(moduleName)
  );
  return {
    module: moduleName,
    permissions: modulePermissions,
  };
});

const seedSuperAdmin = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    logger.info(" DB Connected");

    const superAdminEmail = "superadmin@system.com";

    const exists = await User.findOne({ email: superAdminEmail });

    if (exists) {
      // If superadmin exists, ensure they have all permissions
      exists.access = fullAccess;
      await exists.save();
      logger.info("Super Admin already exists. All permissions have been updated.");
      process.exit(0);
    }

    await User.create({
      name: "Super Admin",
      email: superAdminEmail,
      password: process.env.SUPER_ADMIN_PASSWORD,
      roleName: "SUPER_ADMIN",
      location: "Head Office",
      access: fullAccess,
      phone: "01000000000",
      isDeleted: false,
    });

    logger.info("Super Admin Created Successfully!");
    process.exit(1);
  } catch (error) {
    logger.error("Seeder Failed:", error.message);
    console.log(error)
    process.exit(1);
  }
};

seedSuperAdmin();
