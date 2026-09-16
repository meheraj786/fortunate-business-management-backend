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
      enum: [
        "running",
        "completed",
        "failed",
        "verified",
        "corrupted",
        "deleted",
        "restored",
        "rolled_back",
        "rollback_failed",
      ],
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
      formatVersion: { type: Number, default: 1 },
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
      uploads: {
        fileCount: { type: Number, default: 0 },
        totalBytes: { type: Number, default: 0 },
        checksum: { type: String, default: null },
      },
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
    phase: { type: String, default: null },
    sourceDatabase: { type: String, default: null },
    targetDatabase: { type: String, default: null },
    completedAt: { type: Date, default: null },
    verifiedAt: { type: Date, default: null },
    validation: {
      verified: { type: Boolean, default: false },
      expectedTotal: { type: Number, default: null },
      actualTotal: { type: Number, default: null },
      mismatches: [{
        name: String,
        expected: Number,
        actual: Number,
        _id: false,
      }],
    },
    rollback: {
      attempted: { type: Boolean, default: false },
      succeeded: { type: Boolean, default: false },
      errorMessage: { type: String, default: null },
    },
    warnings: [{ type: String }],
  },
  {
    timestamps: true,
  }
);

// Index for operation/history status views.
backupHistorySchema.index({ status: 1, createdAt: -1 });

// Index for retention queries
backupHistorySchema.index({ retentionTag: 1, createdAt: -1 });

const BackupHistory = mongoose.model("BackupHistory", backupHistorySchema);

module.exports = BackupHistory;
