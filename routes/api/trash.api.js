const express = require("express");
const {
  getAllTrash,
  restoreFromTrash,
  deleteTrashPermanently,
  moveToTrash,
} = require("../../controllers/trash.controller");

const trashRouter = express.Router();

trashRouter.post("/move-to-trash", moveToTrash);

trashRouter.get("/get", getAllTrash);

trashRouter.post("/restore/:id", restoreFromTrash);

trashRouter.delete("/delete/:id", deleteTrashPermanently);

module.exports = trashRouter;
