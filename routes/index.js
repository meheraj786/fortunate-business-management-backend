const express=require("express")
const apiRoutes = require("./api")
const routers=express.Router()

routers.use("/api/v1", apiRoutes)

module.exports=routers