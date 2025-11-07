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
} = require("../../controllers/sales.controller");
const salesRoutes = express.Router();

salesRoutes.post("/create-sales", createSale);
salesRoutes.get("/get-all-sales", getAllSales);
salesRoutes.get("/get-sales/:id", getSaleById);
salesRoutes.patch("/update-sales/:id", updateSale);
salesRoutes.delete("/delete-sales/:id", deleteSale);
salesRoutes.get("/sales-summary", getSalesSummary);

// filtered invoices
salesRoutes.get("/get-all-not-invoices", getAll_not_invoices);
salesRoutes.get("/get-all-paid-invoices", getAll_paid_invoices);
salesRoutes.get("/get-all-due-invoices", getAll_due_invoices);
salesRoutes.get("/get-all-cancelled-invoices", getAll_cancelled_invoices);

module.exports = salesRoutes;
