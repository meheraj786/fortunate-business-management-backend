const express=require("express")
const { createWarehouse, getAllWarehouses, getWarehouseById, updateWarehouse, deleteWarehouse } = require("../../controllers/warehouse.controller")
const warehouseRoutes=express.Router()

warehouseRoutes.post("/create-warehouse", createWarehouse)
warehouseRoutes.get("/get-all-warehouse", getAllWarehouses)
warehouseRoutes.get("/get-warehouse/:id", getWarehouseById)
warehouseRoutes.patch("/update-warehouse/:id", updateWarehouse)
warehouseRoutes.delete("/update-warehouse/:id", deleteWarehouse)


module.exports=warehouseRoutes