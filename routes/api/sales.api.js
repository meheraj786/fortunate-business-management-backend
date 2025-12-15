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
const authorize = require("../../middleware/authorize.middleware"); 
const salesRoutes = express.Router();

salesRoutes.post("/create-sales", authenticate, authorize("SALES", "CREATE"), createSale);
salesRoutes.get("/get-all-sales", authenticate, authorize("SALES", "GET"), getAllSales);
salesRoutes.get("/get-sales/:id", authenticate, authorize("SALES", "GET"), getSaleById);
salesRoutes.patch("/update-sale/:id", authenticate, authorize("SALES", "GET"), updateSale);
salesRoutes.delete("/delete-sale/:id", authenticate, authorize("SALES", "DELETE"), deleteSale);
salesRoutes.patch("/cancel-sale/:id", authenticate, authorize("SALES", "UPDATE"), cancelSale);
salesRoutes.get("/sales-summary", authenticate, authorize("SALES", "GET"), getSalesSummary);
salesRoutes.get("/customer/:customerId", authenticate, authorize("SALES", "GET"), getSalesByCustomerId);

salesRoutes.get("/get-all-invoices-status-count", getAll_invoices_status_count);
salesRoutes.post("/:id/payments", addPartialPayment);

// New comprehensive sales summary route
salesRoutes.get("/sales-summary-table", authenticate, authorize("SALES", "GET"), getPaginatedSalesSummary);

module.exports = salesRoutes;
