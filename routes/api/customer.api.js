const express = require("express");
const {
  createCustomer,
  getAllCustomers,
  getCustomerById,
  updateCustomer,
  getCustomerStats,
  deleteCustomer,
  getCustomersSummary,
  getAllActiveCustomers,
  downloadCustomerDocument,
  deleteCustomerDocument,
  upload,
} = require("../../controllers/customer.controller");
const { authorize } = require("../../middleware/authorize.middleware");
const { authenticate } = require("../../middleware/auth.middleware");
const { PERMISSIONS } = require("../../utils/permissions.constants");
const customerRoutes = express.Router();

customerRoutes.post(
  "/create-customer",
  authenticate,
  authorize(PERMISSIONS.CUSTOMER_CREATE),
  upload.array("documents"),
  createCustomer
);
customerRoutes.get(
  "/get-customers",
  authenticate,
  authorize(PERMISSIONS.CUSTOMER_VIEW_TABLE),
  getAllCustomers
);
customerRoutes.get(
  "/get-active-customers",
  authenticate,
  getAllActiveCustomers
);
customerRoutes.get(
  "/get-customer/:id",
  authenticate,
  authorize(PERMISSIONS.CUSTOMER_VIEW_DETAILS),
  getCustomerById
);
customerRoutes.patch(
  "/update-customer/:id",
  authenticate,
  authorize(PERMISSIONS.CUSTOMER_UPDATE),
  upload.array("documents"),
  updateCustomer
);
customerRoutes.delete(
  "/delete-customer/:id",
  authenticate,
  authorize(PERMISSIONS.CUSTOMER_DELETE),
  deleteCustomer
);
customerRoutes.get(
  "/get-customer-stats",
  authenticate,
  authorize(PERMISSIONS.CUSTOMER_VIEW_TABLE),
  getCustomerStats
);
customerRoutes.get(
  "/summary",
  authenticate,
  authorize(PERMISSIONS.CUSTOMER_VIEW_TABLE),
  getCustomersSummary
);

// Document Routes
customerRoutes.get(
    "/:id/documents/:docId",
    authenticate,
    authorize(PERMISSIONS.CUSTOMER_VIEW_DETAILS), // Or a more specific permission
    downloadCustomerDocument
);

customerRoutes.delete(
    "/:id/documents/:docId",
    authenticate,
    authorize(PERMISSIONS.CUSTOMER_UPDATE), // Or a more specific permission
    deleteCustomerDocument
);

module.exports = customerRoutes;