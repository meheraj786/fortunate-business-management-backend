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
  getPaginatedSalesSummary, // New import
} = require("../../controllers/sales.controller");
const { authenticate } = require("../../middleware/auth.middleware");
const {
  getInvoiceAsPdf,
  getInvoiceAsPng,
} = require("../../controllers/generatedInvoice.controller");
const authorize = require("../../middleware/authorize.middleware"); 
const salesRoutes = express.Router();

salesRoutes.post("/create-sales", authenticate, authorize("SALE", "CREATE"), createSale);
salesRoutes.get("/get-all-sales", authenticate, authorize("SALE", "GET"), getAllSales);
salesRoutes.get("/get-sales/:id", authenticate, authorize("SALE", "GET"), getSaleById);
salesRoutes.patch("/update-sale/:id", authenticate, authorize("SALE", "GET"), updateSale);
salesRoutes.delete("/delete-sale/:id", authenticate, authorize("SALE", "DELETE"), deleteSale);
salesRoutes.patch("/cancel-sale/:id", authenticate, authorize("SALE", "UPDATE"), cancelSale);
salesRoutes.get("/sales-summary", authenticate, authorize("SALE", "GET"), getSalesSummary);
salesRoutes.get("/customer/:customerId", authenticate, authorize("SALE", "GET"), getSalesByCustomerId);

salesRoutes.get("/get-all-invoices-status-count", getAll_invoices_status_count);
salesRoutes.post("/:id/payments", addPartialPayment);

// New comprehensive sales summary route
salesRoutes.get("/sales-summary-table", authenticate, authorize("SALE", "GET"), getPaginatedSalesSummary);

// Routes for generating invoice files
salesRoutes.get("/invoice/:invoiceId/pdf", authenticate, getInvoiceAsPdf);
salesRoutes.get("/invoice/:invoiceId/png", authenticate, getInvoiceAsPng);

module.exports = salesRoutes;
