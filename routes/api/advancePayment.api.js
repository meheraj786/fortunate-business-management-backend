const express = require("express");
const {
    createAdvancePayment,
    getAllAdvancePayments,
    getAdvancePaymentById,
    settleAdvancePayment,
    refundAdvancePayment,
    deleteAdvancePayment,
    getAdvancePaymentStats,
} = require("../../controllers/advancePayment.controller");
const { authenticate } = require("../../middleware/auth.middleware");
const { authorize } = require("../../middleware/authorize.middleware");
const { PERMISSIONS } = require("../../utils/permissions.constants");

const advancePaymentRoutes = express.Router();

advancePaymentRoutes.use(authenticate);

advancePaymentRoutes.post(
    "/",
    authorize(PERMISSIONS.ADVANCE_PAYMENT_CREATE),
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
