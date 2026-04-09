const express = require("express");
const {
  createProductInWarehouse,
  getProductsByWarehouse,
  getProductInWarehouse,
  updateProductInWarehouse,
  deleteProductInWarehouse,
  getProductSalesHistory,
  getProductsForSale,
  closeLotInWarehouse,
} = require("../../controllers/product.controller");
const {
  transferStock,
} = require("../../controllers/warehouse.controller");
const { authenticate } = require("../../middleware/auth.middleware");
const {
  authorizeWarehouseAccess,
} = require("../../middleware/authorize.middleware");
const { PERMISSIONS } = require("../../utils/permissions.constants");

const productRoutes = express.Router({ mergeParams: true });

productRoutes.use(authenticate);

// @desc    Get products for sales dropdown
// @route   GET /api/v1/warehouses/:warehouseId/products/for-sale
// @access  Private (requires SALE_CREATE permission)
productRoutes.get(
  "/for-sale",
  authorizeWarehouseAccess(PERMISSIONS.SALE_CREATE),
  getProductsForSale
);

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
productRoutes.post(
  "/:productId/close-lot",
  authorizeWarehouseAccess(PERMISSIONS.PRODUCT_LOT_CLOSE),
  closeLotInWarehouse
);

// @desc    Transfer stock to another warehouse (full or partial)
// @route   POST /api/v1/warehouses/:warehouseId/products/:productId/transfer
// @access  Private (requires PRODUCT_TRANSFER permission + access to both warehouses)
productRoutes.post(
  "/:productId/transfer",
  authorizeWarehouseAccess(PERMISSIONS.PRODUCT_TRANSFER),
  transferStock
);

module.exports = productRoutes;

