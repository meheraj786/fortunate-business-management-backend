const express = require("express");
const {
  createProductInWarehouse,
  getProductsByWarehouse,
  getProductInWarehouse,
  updateProductInWarehouse,
  deleteProductInWarehouse,
  getProductSalesHistory,
} = require("../../controllers/product.controller");
const { authenticate } = require("../../middleware/auth.middleware");
const {
  authorizeWarehouseAccess,
} = require("../../middleware/authorize.middleware");
const { PERMISSIONS } = require("../../utils/permissions.constants");

const productRoutes = express.Router({ mergeParams: true });

productRoutes.use(authenticate);

productRoutes.post(
  "/",
  authorizeWarehouseAccess(PERMISSIONS.PRODUCT_CREATE),
  createProductInWarehouse
);
productRoutes.get(
  "/",
  authorizeWarehouseAccess(PERMISSIONS.PRODUCT_VIEW_TABLE),
  getProductsByWarehouse
);
productRoutes.get(
  "/:productId",
  authorizeWarehouseAccess(PERMISSIONS.PRODUCT_VIEW_DETAILS),
  getProductInWarehouse
);
productRoutes.get(
  "/:productId/sales",
  authorizeWarehouseAccess(PERMISSIONS.PRODUCT_VIEW_DETAILS),
  getProductSalesHistory
);
productRoutes.patch(
  "/:productId",
  authorizeWarehouseAccess(PERMISSIONS.PRODUCT_UPDATE),
  updateProductInWarehouse
);
productRoutes.delete(
  "/:productId",
  authorizeWarehouseAccess(PERMISSIONS.PRODUCT_DELETE),
  deleteProductInWarehouse
);

module.exports = productRoutes;
