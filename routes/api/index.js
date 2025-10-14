const express=require("express")
const userRoutes = require("./user.api")
const apiRoutes=express.Router()

apiRoutes.use("/auth", userRoutes)


module.exports=apiRoutes