const express=require("express")
const { registerUser } = require("../../controllers/user.controller")
const userRoutes=express.Router()

userRoutes.post("/create-user", registerUser)

module.exports=userRoutes