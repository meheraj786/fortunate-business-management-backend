const mongoose = require("mongoose");
const User = require("../models/user.model");
const logger = require("./logger");
require("dotenv").config();

const fullAccess = [
  {
    module: "LC",
    permissions: ["CREATE", "GET", "UPDATE", "DELETE"],
  },
  {
    module: "SALE",
    permissions: ["CREATE", "GET", "UPDATE", "DELETE"],
  },
  {
    module: "CASH",
    permissions: ["CREATE", "GET", "UPDATE", "DELETE"],
  },
  {
    module: "STOCK",
    permissions: ["CREATE", "GET", "UPDATE", "DELETE"],
  },
  {
    module: "BANKING",
    permissions: ["CREATE", "GET", "UPDATE", "DELETE"],
  },
  {
    module: "CUSTOMER",
    permissions: ["CREATE", "GET", "UPDATE", "DELETE"],
  },
];

const seedSuperAdmin = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    logger.info(" DB Connected");

    const superAdminEmail = "superadmin@system.com";

    const exists = await User.findOne({ email: superAdminEmail });

    if (exists) {
      logger.info("Super Admin already exists. No new user created.");
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
      isDeleted: false
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
