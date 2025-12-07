const express = require("express");
const {
  createCustomer,
  getAllCustomers,
  getCustomerById,
  updateCustomer,
  getCustomerStats,
  deleteCustomer,
  getCustomersSummary,
} = require("../../controllers/customer.controller");
const authorize = require("../../middleware/authorize.middleware");
const { authMiddleware } = require("../../middleware/auth.middleware");
const customerRoutes = express.Router();

customerRoutes.post("/create-customer",  createCustomer);
customerRoutes.get("/get-customers",  getAllCustomers);
customerRoutes.get("/get-customer/:id",  getCustomerById);
customerRoutes.patch("/update-customer/:id",  updateCustomer);
customerRoutes.delete("/delete-customer/:id",  deleteCustomer);
customerRoutes.get("/get-customer-stats",  getCustomerStats);
customerRoutes.get("/summary",  getCustomersSummary);

module.exports = customerRoutes;