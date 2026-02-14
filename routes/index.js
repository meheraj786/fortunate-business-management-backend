const express = require("express")
const apiRoutes = require("./api")
const routers = express.Router()

const backupRoutes = require("./api/backup.api");

routers.use("/api/v1", apiRoutes)
routers.use("/api/v1/backups", backupRoutes);


module.exports = routers