const AuditLog = require("../models/auditLog.model");
const { ApiResponse } = require("../utils/ApiResponse");
const { ApiError } = require("../utils/ApiError");
const logger = require("../utils/logger");
const mongoose = require("mongoose");
const { escapeRegex } = require("../utils/regex.util");

/**
 * Get paginated audit logs with filtering support.
 *
 * Query params:
 * - page (default 1)
 * - limit (default 20, max 100)
 * - module (e.g., "Sale", "Customer")
 * - action (e.g., "CREATE", "UPDATE")
 * - userId (ObjectId)
 * - documentId (ObjectId)
 * - search (searches description)
 * - startDate, endDate (ISO strings for date range)
 * - sortOrder (asc/desc, default desc)
 */
async function getAuditLogs(req, res, next) {
    try {
        const {
            page = 1,
            limit = 20,
            module,
            action,
            userId,
            documentId,
            search,
            startDate,
            endDate,
            sortOrder = "desc",
        } = req.query;

        const pageNum = Math.max(1, parseInt(page, 10));
        const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
        const skip = (pageNum - 1) * limitNum;

        // Build filter
        const filter = {};

        if (module) filter.module = module;
        if (action) filter.action = action;
        if (userId && mongoose.Types.ObjectId.isValid(userId)) {
            filter.userId = new mongoose.Types.ObjectId(userId);
        }
        if (documentId && mongoose.Types.ObjectId.isValid(documentId)) {
            filter.documentId = new mongoose.Types.ObjectId(documentId);
        }
        if (search) {
            filter.description = { $regex: escapeRegex(search), $options: "i" };
        }
        if (startDate || endDate) {
            filter.timestamp = {};
            if (startDate) filter.timestamp.$gte = new Date(startDate);
            if (endDate) filter.timestamp.$lte = new Date(endDate);
        }

        const sortDir = sortOrder === "asc" ? 1 : -1;

        const [logs, totalItems] = await Promise.all([
            AuditLog.find(filter)
                .sort({ timestamp: sortDir })
                .skip(skip)
                .limit(limitNum)
                .populate("userId", "name email")
                .lean(),
            AuditLog.countDocuments(filter),
        ]);

        return res.status(200).json(
            new ApiResponse(
                200,
                {
                    logs,
                    totalItems,
                    totalPages: Math.ceil(totalItems / limitNum),
                    currentPage: pageNum,
                },
                "Audit logs fetched successfully",
            ),
        );
    } catch (error) {
        logger.error("Get audit logs failed:", error);
        if (error instanceof ApiError) return next(error);
        next(
            new ApiError(
                500,
                "An unexpected error occurred. Please try again.",
                [],
                error.message,
            ),
        );
    }
}

/**
 * Get a single audit log entry by ID.
 */
async function getAuditLogById(req, res, next) {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return next(new ApiError(400, "Invalid audit log ID"));
        }

        const log = await AuditLog.findById(id)
            .populate("userId", "name email")
            .lean();

        if (!log) {
            return next(new ApiError(404, "Audit log entry not found"));
        }

        return res
            .status(200)
            .json(new ApiResponse(200, log, "Audit log entry fetched successfully"));
    } catch (error) {
        logger.error("Get audit log by ID failed:", error);
        if (error instanceof ApiError) return next(error);
        next(
            new ApiError(
                500,
                "An unexpected error occurred. Please try again.",
                [],
                error.message,
            ),
        );
    }
}

module.exports = {
    getAuditLogs,
    getAuditLogById,
};
