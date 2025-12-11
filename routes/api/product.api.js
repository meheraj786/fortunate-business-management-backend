const express = require("express");
const {
  createProductInWarehouse,
  getProductsByWarehouse,
  getProductInWarehouse,
  updateProductInWarehouse,
  deleteProductInWarehouse,
} = require("../../controllers/product.controller");
const { authenticate } = require("../../middleware/auth.middleware");

// Note: This router is now intended to be mounted under a /warehouses/:warehouseId prefix
// The 'mergeParams: true' option is crucial for accessing :warehouseId from the parent router
const productRoutes = express.Router({ mergeParams: true });

// Corresponds to POST /api/warehouses/:warehouseId/products
productRoutes.post("/", authenticate,  createProductInWarehouse);

// Corresponds to GET /api/warehouses/:warehouseId/products
productRoutes.get("/", getProductsByWarehouse);

// Corresponds to GET /api/warehouses/:warehouseId/products/:productId
productRoutes.get("/:productId", getProductInWarehouse);

// Corresponds to PATCH /api/warehouses/:warehouseId/products/:productId
productRoutes.patch("/:productId", updateProductInWarehouse);

// Corresponds to DELETE /api/warehouses/:warehouseId/products/:productId
productRoutes.delete("/:productId", deleteProductInWarehouse);

module.exports = productRoutes;
