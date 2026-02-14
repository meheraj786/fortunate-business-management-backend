const mongoose = require("mongoose");

const systemSettingsSchema = new mongoose.Schema(
  {
    timezone: {
      type: String,
      required: true,
      default: "Asia/Dhaka",
      enum: [
        // Americas
        "America/New_York", // EST/EDT (UTC-5/-4)
        "America/Chicago", // CST/CDT (UTC-6/-5)
        "America/Denver", // MST/MDT (UTC-7/-6)
        "America/Los_Angeles", // PST/PDT (UTC-8/-7)
        "America/Toronto", // Canada Eastern
        "America/Sao_Paulo", // Brazil

        // Europe
        "Europe/London", // GMT/BST (UTC+0/+1)
        "Europe/Paris", // CET/CEST (UTC+1/+2)
        "Europe/Berlin", // Germany
        "Europe/Rome", // Italy
        "Europe/Moscow", // Russia (UTC+3)
        "Europe/Istanbul", // Turkey (UTC+3)

        // Asia
        "Asia/Dubai", // UAE (UTC+4)
        "Asia/Karachi", // Pakistan (UTC+5)
        "Asia/Kolkata", // India (UTC+5:30)
        "Asia/Dhaka", // Bangladesh (UTC+6)
        "Asia/Bangkok", // Thailand (UTC+7)
        "Asia/Singapore", // Singapore (UTC+8)
        "Asia/Hong_Kong", // Hong Kong (UTC+8)
        "Asia/Shanghai", // China (UTC+8)
        "Asia/Tokyo", // Japan (UTC+9)
        "Asia/Seoul", // South Korea (UTC+9)

        // Pacific
        "Australia/Sydney", // Australia Eastern (UTC+10/+11)
        "Australia/Melbourne", // Australia
        "Pacific/Auckland", // New Zealand (UTC+12/+13)

        // Africa
        "Africa/Cairo", // Egypt (UTC+2)
        "Africa/Johannesburg", // South Africa (UTC+2)
        "Africa/Lagos", // Nigeria (UTC+1)
      ],
    },
    isTimezoneSet: {
      type: Boolean,
      default: false,
      // Once true, timezone cannot be changed
    },
    timezoneSetAt: {
      type: Date,
      default: null,
      // Timestamp when timezone was permanently set
    },
    timezoneSetBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      // SuperAdmin who set the timezone
    },
    businessName: {
      type: String,
      default: "Fortunate Business Management",
    },
    currency: {
      type: String,
      default: "USD",
    },
    dateFormat: {
      type: String,
      default: "MM/DD/YYYY",
      enum: ["MM/DD/YYYY", "DD/MM/YYYY", "YYYY-MM-DD"],
    },
    timeFormat: {
      type: String,
      default: "12h",
      enum: ["12h", "24h"],
    },
    timeFormat: {
      type: String,
      default: "12h",
      enum: ["12h", "24h"],
    },
    backup: {
      frequency: {
        type: String,
        enum: ["Daily", "Weekly", "Monthly"],
        default: "Daily",
      },
      time: {
        type: String,
        default: "02:00", // 24h format
      },
      retentionCount: {
        type: Number,
        default: 7,
      },
      includeFiles: {
        type: Boolean,
        default: true,
      },
      encryption: {
        enabled: {
          type: Boolean,
          default: false,
        },
        password: {
          type: String,
          select: false, // Do not return by default
        },
      },
    },
  },
  {
    timestamps: true,
  },
);

// Ensure only one settings document exists (singleton pattern)
systemSettingsSchema.statics.getSingleton = async function () {
  let settings = await this.findOne();
  if (!settings) {
    // Create default settings
    settings = await this.create({
      timezone: process.env.TZ || "Asia/Dhaka",
      businessName: "Fortunate Business Management",
      currency: "USD",
      backup: {
        frequency: "Daily",
        time: "02:00",
        retentionCount: 7,
        includeFiles: true,
        encryption: {
          enabled: false,
        }
      },
    });
  }
  return settings;
};

systemSettingsSchema.statics.getSingletonWithPassword = async function () {
  return this.findOne().select('+backup.encryption.password');
};

// Update settings (ensures only one document exists)
systemSettingsSchema.statics.updateSingleton = async function (updateData) {
  let settings = await this.findOne();
  if (!settings) {
    settings = await this.create(updateData);
  } else {
    Object.assign(settings, updateData);
    await settings.save();
  }
  return settings;
};

const SystemSettings = mongoose.model("SystemSettings", systemSettingsSchema);

module.exports = SystemSettings;
