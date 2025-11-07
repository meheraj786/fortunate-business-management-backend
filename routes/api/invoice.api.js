const express = require("express");
const {
  generateInvoice,
  getAllInvoices,
  getInvoiceById,
  getInvoicesBySaleId,
} = require("../../controllers/invoice.controller");
const {
  verifyJWT,
  authorizeRoles,
} = require("../../middleware/auth.middleware");

const router = express.Router();

// All routes in this file are protected and accessible only to admin and manager
// router.use(verifyJWT, authorizeRoles("admin", "manager"));

router.post("/generate", generateInvoice);
router.get("/", getAllInvoices);
router.get("/:id", getInvoiceById);
router.get("/sale/:saleId", getInvoicesBySaleId);

module.exports = router;
