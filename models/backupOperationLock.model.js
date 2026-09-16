const mongoose = require("mongoose");

const backupOperationLockSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "backup-restore" },
    owner: { type: String, required: true },
    operation: { type: String, enum: ["backup", "restore"], required: true },
    expiresAt: { type: Date, required: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, versionKey: false },
);

module.exports = mongoose.model("BackupOperationLock", backupOperationLockSchema);
