const express = require("express");
const {
  createUnit,
  getUnits,
  getUnitById,
  updateUnit,
  deleteUnit,
} = require("../../controllers/unit.controller");
const { authenticate } = require("../../middleware/auth.middleware");
const { authorize } = require("../../middleware/authorize.middleware");
const { PERMISSIONS } = require("../../utils/permissions.constants");
const unitRouter = express.Router();

unitRouter.use(authenticate);

unitRouter.post("/create-unit", authorize(PERMISSIONS.UNIT_CREATE), createUnit);
unitRouter.get("/get-all-units", authorize(PERMISSIONS.UNIT_VIEW), getUnits);
unitRouter.get("/get-unit/:id", authorize(PERMISSIONS.UNIT_VIEW), getUnitById);
unitRouter.put(
  "/update-unit/:id",
  authorize(PERMISSIONS.UNIT_UPDATE),
  updateUnit
);
unitRouter.delete(
  "/delete-unit/:id",
  authorize(PERMISSIONS.UNIT_DELETE),
  deleteUnit
);

module.exports = unitRouter;
