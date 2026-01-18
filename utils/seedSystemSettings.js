const SystemSettings = require("../models/systemSettings.model");
const logger = require("../utils/logger");

/**
 * Seed script to initialize system settings
 * Run this once after deploying the timezone system
 */
async function seedSystemSettings() {
  try {
    // Check if settings already exist
    const existing = await SystemSettings.findOne();

    if (existing) {
      logger.info("System settings already exist:", existing);
      return existing;
    }

    // Create default settings
    const settings = await SystemSettings.create({
      timezone: process.env.TZ || "Asia/Dhaka",
      businessName: "Fortunate Business Management",
      currency: "USD",
      dateFormat: "MM/DD/YYYY",
      timeFormat: "12h",
    });

    logger.info("System settings created successfully:", settings);
    return settings;
  } catch (error) {
    logger.error("Failed to seed system settings:", error);
    throw error;
  }
}

// Auto-run if called directly
if (require.main === module) {
  require("dotenv").config();
  const mongoose = require("mongoose");

  mongoose
    .connect(process.env.MONGODB_URI)
    .then(async () => {
      logger.info("Connected to MongoDB");
      await seedSystemSettings();
      process.exit(0);
    })
    .catch((error) => {
      logger.error("MongoDB connection failed:", error);
      process.exit(1);
    });
}

module.exports = { seedSystemSettings };
