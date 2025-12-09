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

customerRoutes.post("/create-customer", authMiddleware, authorize("CUSTOMER", "CREATE"), createCustomer);
customerRoutes.get("/get-customers", authMiddleware, authorize("CUSTOMER", "GET"), getAllCustomers);
customerRoutes.get("/get-customer/:id", authMiddleware, authorize("CUSTOMER", "GET"), getCustomerById);
customerRoutes.patch("/update-customer/:id", authMiddleware, authorize("CUSTOMER", "UPDATE"), updateCustomer);
customerRoutes.delete("/delete-customer/:id", authMiddleware, authorize("CUSTOMER", "DELETE"), deleteCustomer);
customerRoutes.get("/get-customer-stats", authMiddleware, authorize("CUSTOMER", "GET"), getCustomerStats);
customerRoutes.get("/summary", authMiddleware, authorize("CUSTOMER", "GET"), getCustomersSummary);

module.exports = customerRoutes;