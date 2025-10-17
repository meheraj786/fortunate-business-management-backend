const express=require("express")
const { createTeamMember, getAllTeamMembers, getTeamMemberById, updateTeamMember, deleteTeamMember } = require("../../controllers/teammember.controller")
const teammemberRoutes=express.Router()

teammemberRoutes.post("/create-teammember", createTeamMember)
teammemberRoutes.get("/get-all-teammember", getAllTeamMembers)
teammemberRoutes.get("/get-teammember/:id", getTeamMemberById)
teammemberRoutes.patch("/update-teammember/:id", updateTeamMember)
teammemberRoutes.delete("/update-teammember/:id", deleteTeamMember)


module.exports=teammemberRoutes