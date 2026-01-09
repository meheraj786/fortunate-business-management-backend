const express = require("express");
const {
  getAllTrash,
  restoreFromTrash,
  deleteTrashPermanently,
  getTrashDetailById,
} = require("../../controllers/trash.controller");
const { authenticate } = require("../../middleware/auth.middleware");
const { authorizeTrashAccess } = require("../../middleware/authorize.middleware");

const trashRouter = express.Router();

// Authenticate all routes in this file
trashRouter.use(authenticate);

// Get all trashed items for a specific model (e.g., /api/trash/LC)
trashRouter.get("/:model", authorizeTrashAccess("VIEW"), getAllTrash);

// Get details of a specific trashed item
trashRouter.get(
  "/:model/:id",
  authorizeTrashAccess("VIEW"),
  getTrashDetailById
);

// Restore a specific item from the trash
trashRouter.post(
  "/:model/:id/restore",
  authorizeTrashAccess("RESTORE"),
  restoreFromTrash
);

// Permanently delete an item from the trash
trashRouter.delete(
  "/:model/:id",
  authorizeTrashAccess("DELETE"),
  deleteTrashPermanently
);

module.exports = trashRouter;
