const AuditLog = require("../models/auditLog.model");
const logger = require("../utils/logger");

/**
 * Audit Service — Fire-and-forget activity logging.
 *
 * Design: Audit log writes are intentionally NOT part of business transactions.
 * They never throw errors and never block the calling request.
 */

/**
 * Log an audit entry. Fire-and-forget — never throws.
 *
 * @param {Object} params
 * @param {string} params.action - CREATE, UPDATE, DELETE, RESTORE, CANCEL, LOGIN, LOGOUT, PAYMENT, TRANSFER, BACKUP, SETTINGS_UPDATE
 * @param {string} params.module - User, Sale, Customer, Product, LC, Account, Transaction, Warehouse, Category, Unit, DailyCash, System
 * @param {string|ObjectId} [params.documentId] - ID of the affected document
 * @param {string} [params.displayId] - Human-readable ID (e.g., SL-00045)
 * @param {string|ObjectId} [params.userId] - Who performed the action
 * @param {string} params.description - Human-readable summary
 * @param {Object} [params.changes] - { before: {}, after: {} }
 * @param {Object} [params.metadata] - Extra context
 * @param {Object} [params.req] - Express request (to extract IP)
 */
const log = async ({
    action,
    module,
    documentId = null,
    displayId = null,
    userId = null,
    description,
    changes = null,
    metadata = {},
    req = null,
}) => {
    try {
        const ipAddress = req
            ? req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null
            : null;

        await AuditLog.create({
            action,
            module,
            documentId,
            displayId,
            userId,
            description,
            changes: changes || { before: null, after: null },
            metadata,
            ipAddress,
        });
    } catch (error) {
        // Silently log the failure — never crash the business operation
        logger.error("Audit log write failed:", {
            action,
            module,
            documentId,
            error: error.message,
        });
    }
};

/**
 * Compute a minimal diff between two objects, tracking only the specified fields.
 * Returns { before: { ...changedFieldsOld }, after: { ...changedFieldsNew } }
 *
 * @param {Object} before - Original document (plain object or Mongoose doc)
 * @param {Object} after - Updated document (plain object or Mongoose doc)
 * @param {string[]} fieldsToTrack - Array of field names to compare
 * @returns {{ before: Object, after: Object }}
 */
const diffChanges = (before, after, fieldsToTrack) => {
    const beforeObj =
        before && typeof before.toObject === "function"
            ? before.toObject()
            : before || {};
    const afterObj =
        after && typeof after.toObject === "function"
            ? after.toObject()
            : after || {};

    const changedBefore = {};
    const changedAfter = {};

    for (const field of fieldsToTrack) {
        const oldVal = getNestedValue(beforeObj, field);
        const newVal = getNestedValue(afterObj, field);

        // Simple JSON comparison for nested objects/arrays
        if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
            changedBefore[field] = oldVal;
            changedAfter[field] = newVal;
        }
    }

    // If nothing changed, return null
    if (Object.keys(changedBefore).length === 0) return null;

    return { before: changedBefore, after: changedAfter };
};

/**
 * Get a nested value from an object using dot notation.
 * e.g., getNestedValue(obj, "customer.name")
 */
function getNestedValue(obj, path) {
    return path.split(".").reduce((acc, part) => {
        if (acc === null || acc === undefined) return undefined;
        return acc[part];
    }, obj);
}

module.exports = {
    log,
    diffChanges,
};
