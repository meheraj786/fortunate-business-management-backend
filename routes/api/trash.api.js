const express = require("express");
const {
  getAllTrash,
  restoreFromTrash,
  deleteTrashPermanently,
  moveToTrash,
  getTrashDetailById,
} = require("../../controllers/trash.controller");

const trashRouter = express.Router();

trashRouter.post("/move-to-trash", moveToTrash);

trashRouter.get("/get", getAllTrash);

trashRouter.post("/restore/:id", restoreFromTrash);

trashRouter.delete("/delete/:id", deleteTrashPermanently);

trashRouter.get("/get-detail/:id", getTrashDetailById);

module.exports = trashRouter;
