const express=require("express")
const { registerUser, loginUser, logoutUser, getProfile, getAllUser, getUser, updateUser, deleteUser } = require("../../controllers/user.controller")
const { authenticate } = require("../../middleware/auth.middleware")
const userRoutes=express.Router()

userRoutes.post("/create-user", authenticate, registerUser)
userRoutes.post("/login", loginUser)
userRoutes.post("/logout", logoutUser)
userRoutes.get("/get-profile", authenticate, getProfile)
userRoutes.patch("/update-user/:id", authenticate, updateUser)
userRoutes.get("/get-users", getAllUser)
userRoutes.get("/get-user/:id", getUser)
userRoutes.delete("/delete-user/:id", authenticate, deleteUser)


module.exports=userRoutes