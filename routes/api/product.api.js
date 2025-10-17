const express=require("express")
const { createProduct, getAllProducts, getProductById, updateProduct, deleteProduct, getInventoryStats, getStockStatus } = require("../../controllers/product.controller")
const productRoutes=express.Router()

productRoutes.post("/create-product", createProduct)
productRoutes.get("/get-all-product", getAllProducts)
productRoutes.get("/get-product/:id", getProductById)
productRoutes.patch("/update-product/:id", updateProduct)
productRoutes.delete("/update-product/:id", deleteProduct)
productRoutes.get("/inventory-stats", getInventoryStats)
productRoutes.get("/stock-stats", getStockStatus)


module.exports=productRoutes