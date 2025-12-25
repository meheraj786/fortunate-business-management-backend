const express = require("express");
const {
  createWarehouse,
  getAllWarehouses,
  getWarehouseById,
  updateWarehouse,
  deleteWarehouse,
} = require("../../controllers/warehouse.controller");
const {
} = require("../../controllers/product.controller");
const productRoutes = require("./product.api");

const warehouseRoutes = express.Router();

// CRUD for warehouses
warehouseRoutes.post("/", createWarehouse);
warehouseRoutes.get("/", getAllWarehouses);
warehouseRoutes.get("/:id", getWarehouseById);
warehouseRoutes.patch("/:id", updateWarehouse);
warehouseRoutes.delete("/:id", deleteWarehouse);

// Nest the product routes under a specific warehouse
warehouseRoutes.use("/:warehouseId/products", productRoutes);

module.exports = warehouseRoutes;
