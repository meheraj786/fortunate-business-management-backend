const express = require("express");
const {
  createSale,
  getAllSales,
  getSaleById,
  updateSale,
  deleteSale,
  getSalesSummary,
  getAll_invoices_status_count,
  addPartialPayment,
  reversePayment,
  cancelSale,
  getSalesByCustomerId,
  getPaginatedSalesSummary,
} = require("../../controllers/sales.controller");
const { authenticate } = require("../../middleware/auth.middleware");
const {
  getInvoiceAsPdf,
  getInvoiceAsPng,
} = require("../../controllers/generatedInvoice.controller");
const { authorize } = require("../../middleware/authorize.middleware");
const { PERMISSIONS } = require("../../utils/permissions.constants");
const { idempotencyGuard } = require("../../middleware/idempotency.middleware");
const salesRoutes = express.Router();

salesRoutes.use(authenticate);

salesRoutes.post(
  "/create-sales",
  authorize(PERMISSIONS.SALE_CREATE),
  idempotencyGuard,
  createSale
);
salesRoutes.get(
  "/get-all-sales",
  authorize(PERMISSIONS.SALE_VIEW_TABLE),
  getAllSales
);
salesRoutes.get(
  "/get-sales/:id",
  authorize(PERMISSIONS.SALE_VIEW_DETAILS),
  getSaleById
);
salesRoutes.patch(
  "/update-sale/:id",
  authorize(PERMISSIONS.SALE_UPDATE),
  updateSale
);
salesRoutes.delete(
  "/delete-sale/:id",
  authorize(PERMISSIONS.SALE_DELETE),
  deleteSale
);
salesRoutes.patch(
  "/cancel-sale/:id",
  authorize(PERMISSIONS.SALE_CANCEL),
  cancelSale
);
salesRoutes.get(
  "/sales-summary",
  authorize(PERMISSIONS.SALE_VIEW_TABLE),
  getSalesSummary
);
salesRoutes.get(
  "/customer/:customerId",
  (req, res, next) => {
    // Allow access if user has SALE_VIEW_TABLE OR CUSTOMER_VIEW_DETAILS
    const user = req.user;
    if (!user) return res.status(401).json({ success: false, message: "Unauthorized" });
    if (user.roleName === "ADMIN" || user.roleName === "SUPER_ADMIN") return next();

    const userPermissions = new Set();
    (user.access || []).forEach((m) => m.permissions.forEach((p) => userPermissions.add(p)));

    if (userPermissions.has(PERMISSIONS.SALE_VIEW_TABLE) || userPermissions.has(PERMISSIONS.CUSTOMER_VIEW_DETAILS)) {
      return next();
    }
    return res.status(403).json({ success: false, message: "Forbidden - You don't have permission to view this customer's sales." });
  },
  getSalesByCustomerId
);

salesRoutes.get(
  "/get-all-invoices-status-count",
  authorize(PERMISSIONS.SALE_VIEW_TABLE),
  getAll_invoices_status_count
);
salesRoutes.post(
  "/:id/payments",
  authorize(PERMISSIONS.SALE_ADD_PAYMENT),
  idempotencyGuard,
  addPartialPayment
);
salesRoutes.delete(
  "/:id/payments/:paymentId",
  authorize(PERMISSIONS.SALE_REVERSE_PAYMENT),
  reversePayment
);

salesRoutes.get(
  "/sales-summary-table",
  authorize(PERMISSIONS.SALE_VIEW_TABLE),
  getPaginatedSalesSummary
);

salesRoutes.get(
  "/invoice/:invoiceId/pdf",
  authorize(PERMISSIONS.SALE_DOWNLOAD_INVOICE),
  getInvoiceAsPdf
);
salesRoutes.get(
  "/invoice/:invoiceId/png",
  authorize(PERMISSIONS.SALE_DOWNLOAD_INVOICE),
  getInvoiceAsPng
);

module.exports = salesRoutes;
