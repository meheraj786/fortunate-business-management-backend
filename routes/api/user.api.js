const express=require("express")
const { registerUser, loginUser } = require("../../controllers/user.controller")
const userRoutes=express.Router()

userRoutes.post("/create-user", registerUser)
userRoutes.post("/login", loginUser)

module.exports=userRoutes