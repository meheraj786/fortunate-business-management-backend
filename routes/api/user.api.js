const express=require("express")
const { registerUser, loginUser, logoutUser, getProfile, getAllUser, getUser } = require("../../controllers/user.controller")
const { authMiddleware } = require("../../middleware/auth.middleware")
const userRoutes=express.Router()

userRoutes.post("/create-user", registerUser)
userRoutes.post("/login", loginUser)
userRoutes.post("/logout", logoutUser)
userRoutes.get("/get-profile", getProfile)
userRoutes.get("/get-users", getAllUser)
userRoutes.get("/get-user/:id", getUser)


module.exports=userRoutes