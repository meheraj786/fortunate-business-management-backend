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
warehouseRoutes.post("/", authorizeRole("SUPER_ADMIN"), createWarehouse);
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
warehouseRoutes.patch("/:id", authorizeRole("SUPER_ADMIN"), updateWarehouse);
warehouseRoutes.delete("/:id", authorizeRole("SUPER_ADMIN"), deleteWarehouse);

// Nest the product routes under a specific warehouse
warehouseRoutes.use("/:warehouseId/products", productRoutes);

module.exports = warehouseRoutes;
