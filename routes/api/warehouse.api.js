const express = require("express");
const {
  createWarehouse,
  getAllWarehouses,
  getWarehouseById,
  updateWarehouse,
  deleteWarehouse,
} = require("../../controllers/warehouse.controller");
const { authenticate } = require("../../middleware/auth.middleware");
const {
  authorize,
  authorizeRole,
} = require("../../middleware/authorize.middleware");
const { PERMISSIONS } = require("../../utils/permissions.constants");
const productRoutes = require("./product.api");

const warehouseRoutes = express.Router();

warehouseRoutes.use(authenticate);

// CRUD for warehouses
warehouseRoutes.post("/", authorize(PERMISSIONS.WAREHOUSE_CREATE), createWarehouse);
warehouseRoutes.get(
  "/",
  authorize(PERMISSIONS.WAREHOUSE_VIEW),
  getAllWarehouses
);
warehouseRoutes.get(
  "/:id",
  authorize(PERMISSIONS.WAREHOUSE_VIEW),
  getWarehouseById
);
warehouseRoutes.patch("/:id", authorize(PERMISSIONS.WAREHOUSE_UPDATE), updateWarehouse);
warehouseRoutes.delete("/:id", authorize(PERMISSIONS.WAREHOUSE_DELETE), deleteWarehouse);

// Nest the product routes under a specific warehouse
warehouseRoutes.use("/:warehouseId/products", productRoutes);

module.exports = warehouseRoutes;
