const express=require("express")
const { registerUser, loginUser, logoutUser, getProfile } = require("../../controllers/user.controller")
const userRoutes=express.Router()

userRoutes.post("/create-user", registerUser)
userRoutes.post("/login", loginUser)
userRoutes.post("/logout", logoutUser)
userRoutes.get("/get-profile", getProfile)


module.exports=userRoutes