const express=require("express")
const { createLC, getAllLCs, getLCById, updateLC, deleteLC, addExpenseToLC } = require("../../controllers/lc.controller")
const lcRoutes=express.Router()

lcRoutes.post("/create-lc", createLC)
lcRoutes.get("/get-all-lc", getAllLCs)
lcRoutes.get("/get-lc/:id", getLCById)
lcRoutes.patch("/update-lc/:id", updateLC)
lcRoutes.delete("/update-lc/:id", deleteLC)
lcRoutes.post("/add-lc-expense/:lcId", addExpenseToLC)


module.exports=lcRoutes