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
const { authenticate } = require("../../middleware/auth.middleware");
const customerRoutes = express.Router();

customerRoutes.post("/create-customer", authenticate, authorize("CUSTOMER", "CREATE"), createCustomer);
customerRoutes.get("/get-customers", authenticate, authorize("CUSTOMER", "GET"), getAllCustomers);
customerRoutes.get("/get-customer/:id", authenticate, authorize("CUSTOMER", "GET"), getCustomerById);
customerRoutes.patch("/update-customer/:id", authenticate, authorize("CUSTOMER", "UPDATE"), updateCustomer);
customerRoutes.delete("/delete-customer/:id", authenticate, authorize("CUSTOMER", "DELETE"), deleteCustomer);
customerRoutes.get("/get-customer-stats", authenticate, authorize("CUSTOMER", "GET"), getCustomerStats);
customerRoutes.get("/summary", authenticate, authorize("CUSTOMER", "GET"), getCustomersSummary);

module.exports = customerRoutes;