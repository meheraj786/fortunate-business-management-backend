const mongoose = require("mongoose");
const User = require("../models/user.model");
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
  {
    module: "CATEGORY",
    permissions: ["CREATE", "GET", "UPDATE", "DELETE"],
  },
  {
    module: "UNIT",
    permissions: ["CREATE", "GET", "UPDATE", "DELETE"],
  },
  {
    module: "WAREHOUSE",
    permissions: ["CREATE", "GET", "UPDATE", "DELETE"],
  },
];

const seedSuperAdmin = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("✅ DB Connected");

    const superAdminEmail = "superadmin@system.com";

    const superAdminData = {
      name: "Super Admin",
      email: superAdminEmail,
      password: "12345678",
      roleName: "SUPER_ADMIN",
      location: "Head Office",
      access: fullAccess,
      phone: "01000000000",
    };

    const exists = await User.findOne({ email: superAdminEmail }).select("+password");

    if (exists) {
      // ✅ Update Existing Super Admin
      exists.name = superAdminData.name;
      exists.password = superAdminData.password; // will auto-hash
      exists.roleName = superAdminData.roleName;
      exists.location = superAdminData.location;
      exists.access = superAdminData.access;
      exists.phone = superAdminData.phone;

      await exists.save();

      console.log("✅ Super Admin Updated Successfully!");
      process.exit(0);
    }

    // ✅ Create New Super Admin
    await User.create(superAdminData);

    console.log("✅ Super Admin Created Successfully!");
    process.exit(0);
  } catch (error) {
    console.error("❌ Seeder Failed:", error.message);
    process.exit(1);
  }
};

seedSuperAdmin();
