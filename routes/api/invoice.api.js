const express = require("express");
const {
  generateInvoice,
  getAllInvoices,
  getInvoiceById,
  getInvoicesBySaleId,
} = require("../../controllers/invoice.controller");
const { authenticate } = require("../../middleware/auth.middleware");
const { authorize } = require("../../middleware/authorize.middleware");
const { PERMISSIONS } = require("../../utils/permissions.constants");

const router = express.Router();

// All routes are protected
router.use(authenticate);

router.post(
  "/generate",
  authorize(PERMISSIONS.SALE_GENERATE_INVOICE),
  generateInvoice
);
router.get("/", authorize(PERMISSIONS.SALE_VIEW_TABLE), getAllInvoices);
router.get("/:id", authorize(PERMISSIONS.SALE_VIEW_INVOICE), getInvoiceById);
router.get(
  "/sale/:saleId",
  authorize(PERMISSIONS.SALE_VIEW_INVOICE),
  getInvoicesBySaleId
);

module.exports = router;
