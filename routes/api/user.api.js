const express=require("express")
const { registerUser, loginUser, logoutUser, getProfile, getAllUser, getUser, updateUser } = require("../../controllers/user.controller")
const { authMiddleware } = require("../../middleware/auth.middleware")
const userRoutes=express.Router()

userRoutes.post("/create-user", authMiddleware, registerUser)
userRoutes.post("/login", loginUser)
userRoutes.post("/logout", logoutUser)
userRoutes.get("/get-profile", authMiddleware, getProfile)
userRoutes.patch("/update-user/:id", authMiddleware, updateUser)
userRoutes.get("/get-users", getAllUser)
userRoutes.get("/get-user/:id", getUser)


module.exports=userRoutes