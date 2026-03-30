const mongoose = require("mongoose");

const backupHistorySchema = new mongoose.Schema(
  {
    filename: {
      type: String,
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ["manual", "scheduled", "restore"],
      required: true,
      default: "manual",
    },
    status: {
      type: String,
      enum: ["running", "completed", "failed", "verified", "corrupted"],
      required: true,
      default: "running",
      index: true,
    },
    initiatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null, // null for scheduled backups
    },
    sizeBytes: {
      type: Number,
      default: 0,
    },
    durationMs: {
      type: Number,
      default: 0,
    },
    encrypted: {
      type: Boolean,
      default: false,
    },
    includesFiles: {
      type: Boolean,
      default: false,
    },
    checksum: {
      type: String, // SHA-256 hex string
      default: null,
    },
    manifest: {
      appVersion: { type: String, default: null },
      dbName: { type: String, default: null },
      collections: [
        {
          name: { type: String },
          documentCount: { type: Number },
          _id: false,
        },
      ],
      totalDocuments: { type: Number, default: 0 },
    },
    retentionTag: {
      type: String,
      enum: ["daily", "weekly", "monthly", "manual"],
      default: "manual",
    },
    notes: {
      type: String,
      default: "",
      maxlength: 500,
    },
    errorMessage: {
      type: String,
      default: null,
    },
    // Restore-specific fields
    restoredFrom: {
      type: String, // Filename of the backup that was restored
      default: null,
    },
    safetyBackupFilename: {
      type: String, // Auto-created safety backup before restore
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Index for finding stale running backups (cluster-safe lock)
backupHistorySchema.index({ status: 1, createdAt: -1 });

// Index for retention queries
backupHistorySchema.index({ retentionTag: 1, createdAt: -1 });

/**
 * Check if any backup is currently running (distributed lock).
 * A backup is considered stale if it's been running for > 30 minutes.
 */
backupHistorySchema.statics.isBackupLocked = async function () {
  const staleThreshold = new Date(Date.now() - 30 * 60 * 1000);

  const runningBackup = await this.findOne({
    status: "running",
    createdAt: { $gt: staleThreshold },
  });

  return !!runningBackup;
};

/**
 * Mark stale backups (running > 30 mins) as failed.
 * Called before checking lock to clean up orphaned locks.
 */
backupHistorySchema.statics.cleanupStaleLocks = async function () {
  const staleThreshold = new Date(Date.now() - 30 * 60 * 1000);

  const result = await this.updateMany(
    {
      status: "running",
      createdAt: { $lte: staleThreshold },
    },
    {
      $set: {
        status: "failed",
        errorMessage: "Backup timed out (stale lock — exceeded 30 minutes)",
      },
    }
  );

  return result.modifiedCount;
};

const BackupHistory = mongoose.model("BackupHistory", backupHistorySchema);

module.exports = BackupHistory;
