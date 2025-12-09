const express = require("express");
const {
  createSale,
  getAllSales,
  getSaleById,
  updateSale,
  deleteSale,
  getSalesSummary,
  getAll_cancelled_invoices,
  getAll_due_invoices,
  getAll_paid_invoices,
  getAll_not_invoices,
  getAll_invoices_status_count,
  addPartialPayment,
  cancelSale,
  getSalesByCustomerId,
  getSalesSummaryForTable, 
} = require("../../controllers/sales.controller");
const { authMiddleware } = require("../../middleware/auth.middleware");
const authorize = require("../../middleware/authorize.middleware"); 
const salesRoutes = express.Router();

salesRoutes.post("/create-sales", authMiddleware, authorize("SALES", "CREATE"), createSale);
salesRoutes.get("/get-all-sales", authMiddleware, authorize("SALES", "GET"), getAllSales);
salesRoutes.get("/get-sales/:id", authMiddleware, authorize("SALES", "GET"), getSaleById);
salesRoutes.patch("/update-sale/:id", authMiddleware, authorize("SALES", "GET"), updateSale);
salesRoutes.delete("/delete-sale/:id", authMiddleware, authorize("SALES", "DELETE"), deleteSale);
salesRoutes.patch("/cancel-sale/:id", authMiddleware, authorize("SALES", "UPDATE"), cancelSale);
salesRoutes.get("/sales-summary", authMiddleware, authorize("SALES", "GET"), getSalesSummary);
salesRoutes.get("/customer/:customerId", authMiddleware, authorize("SALES", "GET"), getSalesByCustomerId);

// filtered invoices
salesRoutes.get("/get-all-not-invoices", getAll_not_invoices);
salesRoutes.get("/get-all-paid-invoices", getAll_paid_invoices);
salesRoutes.get("/get-all-due-invoices", getAll_due_invoices);
salesRoutes.get("/get-all-cancelled-invoices", getAll_cancelled_invoices);
salesRoutes.get("/get-all-invoices-status-count", getAll_invoices_status_count);
salesRoutes.post("/:id/payments", addPartialPayment);

// New route for sales summary table
salesRoutes.get("/summary-for-table", getSalesSummaryForTable);

module.exports = salesRoutes;
