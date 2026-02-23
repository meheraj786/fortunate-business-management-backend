const express = require("express");
const {
    getAuditLogs,
    getAuditLogById,
} = require("../../controllers/audit.controller");
const { authenticate } = require("../../middleware/auth.middleware");
const { authorize } = require("../../middleware/authorize.middleware");
const { PERMISSIONS } = require("../../utils/permissions.constants");

const auditRouter = express.Router();

auditRouter.get(
    "/",
    authenticate,
    authorize(PERMISSIONS.AUDIT_VIEW),
    getAuditLogs,
);

auditRouter.get(
    "/:id",
    authenticate,
    authorize(PERMISSIONS.AUDIT_VIEW),
    getAuditLogById,
);

module.exports = auditRouter;
