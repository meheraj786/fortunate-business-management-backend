const express=require("express")
const { createLC, getAllLCs, getLCById, updateLC, deleteLC, addExpenseToLC } = require("../../controllers/lc.controller")
const { authMiddleware } = require("../../middleware/auth.middleware")
const lcRoutes=express.Router()

lcRoutes.post("/create-lc",authMiddleware, createLC)
lcRoutes.get("/get-all-lc",authMiddleware, getAllLCs)
lcRoutes.get("/get-lc/:id", getLCById)
lcRoutes.patch("/update-lc/:id", updateLC)
lcRoutes.delete("/delete-lc/:id", deleteLC)
lcRoutes.post("/add-lc-expense/:lcId", addExpenseToLC)


module.exports=lcRoutes