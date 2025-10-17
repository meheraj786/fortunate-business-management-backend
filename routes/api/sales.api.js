const express=require("express")
const { createSale, getAllSales, getSaleById, updateSale, deleteSale, getSalesSummary } = require("../../controllers/sales.controller")
const salesRoutes=express.Router()

salesRoutes.post("/create-sales", createSale)
salesRoutes.get("/get-all-sales", getAllSales)
salesRoutes.get("/get-sales/:id", getSaleById)
salesRoutes.patch("/update-sales/:id", updateSale)
salesRoutes.delete("/delete-sales/:id", deleteSale)
salesRoutes.get("/sales-summary", getSalesSummary)


module.exports=salesRoutes