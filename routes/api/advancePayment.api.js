const express = require("express");
const {
    createAdvancePayment,
    getAllAdvancePayments,
    getAdvancePaymentById,
    addToAdvancePayment,
    settleAdvancePayment,
    refundAdvancePayment,
    deleteAdvancePayment,
    getAdvancePaymentStats,
} = require("../../controllers/advancePayment.controller");
const { authenticate } = require("../../middleware/auth.middleware");
const { authorize } = require("../../middleware/authorize.middleware");
const { PERMISSIONS } = require("../../utils/permissions.constants");
const { idempotencyGuard } = require("../../middleware/idempotency.middleware");

const advancePaymentRoutes = express.Router();

advancePaymentRoutes.use(authenticate);

advancePaymentRoutes.post(
    "/",
    authorize(PERMISSIONS.ADVANCE_PAYMENT_CREATE),
    idempotencyGuard,
    createAdvancePayment,
);

advancePaymentRoutes.get(
    "/",
    authorize(PERMISSIONS.ADVANCE_PAYMENT_VIEW),
    getAllAdvancePayments,
);

advancePaymentRoutes.get(
    "/stats",
    authorize(PERMISSIONS.ADVANCE_PAYMENT_VIEW),
    getAdvancePaymentStats,
);

advancePaymentRoutes.get(
    "/:id",
    authorize(PERMISSIONS.ADVANCE_PAYMENT_VIEW_DETAILS),
    getAdvancePaymentById,
);

advancePaymentRoutes.put(
    "/:id/settle",
    authorize(PERMISSIONS.ADVANCE_PAYMENT_SETTLE),
    settleAdvancePayment,
);

advancePaymentRoutes.put(
    "/:id/add",
    authorize(PERMISSIONS.ADVANCE_PAYMENT_CREATE),
    idempotencyGuard,
    addToAdvancePayment,
);

advancePaymentRoutes.put(
    "/:id/refund",
    authorize(PERMISSIONS.ADVANCE_PAYMENT_REFUND),
    refundAdvancePayment,
);

advancePaymentRoutes.delete(
    "/:id",
    authorize(PERMISSIONS.ADVANCE_PAYMENT_DELETE),
    deleteAdvancePayment,
);

module.exports = advancePaymentRoutes;
