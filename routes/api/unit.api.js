const express = require("express");
const {
  createUnit,
  getUnits,
  getUnitById,
  updateUnit,
  deleteUnit,
} = require("../../controllers/unit.controller");
const unitRouter = express.Router();

unitRouter.post("/create", createUnit);
unitRouter.get("/get", getUnits);
unitRouter.get("/get/:id", getUnitById);
unitRouter.put("/update/:id", updateUnit);
unitRouter.delete("/delete/:id", deleteUnit);

module.exports = unitRouter;
