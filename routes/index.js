const express = require("express")
const apiRoutes = require("./api")
const routers = express.Router()

const backupRoutes = require("./api/backup.api");
const restoreRoutes = require("./api/restore.api");

routers.use("/api/v1", apiRoutes)
routers.use("/api/v1/backups", backupRoutes);
routers.use("/api/v1/restore", restoreRoutes);


module.exports = routers