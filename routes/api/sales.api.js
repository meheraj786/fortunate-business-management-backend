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
  authorize(PERMISSIONS.SALE_VIEW_TABLE),
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
