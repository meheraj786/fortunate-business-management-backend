const mongoose = require("mongoose");

const auditLogSchema = new mongoose.Schema(
    {
        action: {
            type: String,
            required: true,
            enum: [
                "CREATE",
                "UPDATE",
                "DELETE",
                "RESTORE",
                "CANCEL",
                "LOGIN",
                "LOGOUT",
                "PAYMENT",
                "TRANSFER",
                "BACKUP",
                "SETTINGS_UPDATE",
                "OPEN",
                "CLOSE",
                "WIPE",
            ],
            index: true,
        },
        module: {
            type: String,
            required: true,
            enum: [
                "User",
                "Sale",
                "Customer",
                "Product",
                "LC",
                "Account",
                "Transaction",
                "Warehouse",
                "Category",
                "Unit",
                "DailyCash",
                "System",
            ],
            index: true,
        },
        documentId: {
            type: mongoose.Schema.Types.ObjectId,
            default: null,
        },
        displayId: {
            type: String,
            default: null,
        },
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null,
        },
        description: {
            type: String,
            required: true,
        },
        changes: {
            before: { type: mongoose.Schema.Types.Mixed, default: null },
            after: { type: mongoose.Schema.Types.Mixed, default: null },
        },
        metadata: {
            type: mongoose.Schema.Types.Mixed,
            default: {},
        },
        ipAddress: {
            type: String,
            default: null,
        },
    },
    {
        timestamps: { createdAt: "timestamp", updatedAt: false },
    },
);

// Compound indexes for common query patterns
auditLogSchema.index({ module: 1, timestamp: -1 });
auditLogSchema.index({ userId: 1, timestamp: -1 });
auditLogSchema.index({ documentId: 1, timestamp: -1 });
auditLogSchema.index({ timestamp: -1 }); // For sorted listing

const AuditLog = mongoose.model("AuditLog", auditLogSchema);

module.exports = AuditLog;
