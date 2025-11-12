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
  getSalesSummaryForTable, // Import the new function
} = require("../../controllers/sales.controller");
const salesRoutes = express.Router();

salesRoutes.post("/create-sales", createSale);
salesRoutes.get("/get-all-sales", getAllSales);
salesRoutes.get("/get-sales/:id", getSaleById);
salesRoutes.patch("/update-sale/:id", updateSale);
salesRoutes.delete("/delete-sale/:id", deleteSale);
salesRoutes.patch("/cancel-sale/:id", cancelSale);
salesRoutes.get("/sales-summary", getSalesSummary);
salesRoutes.get("/customer/:customerId", getSalesByCustomerId);

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
