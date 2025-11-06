const express = require("express");
const {
  createLC,
  getAllLCs,
  getLCById,
  updateLC,
  deleteLC,
  addExpenseToLC,
  getAllCompletedLCs,
  upload,
} = require("../../controllers/lc.controller");
const lcRoutes = express.Router();

lcRoutes.post("/create-lc", upload.array('documents'), createLC);
lcRoutes.get("/get-all-lc", getAllLCs);
lcRoutes.get("/get-lc/:id", getLCById);
lcRoutes.patch("/update-lc/:id", updateLC);
lcRoutes.delete("/delete-lc/:id", deleteLC);
lcRoutes.post("/add-lc-expense/:lcId", addExpenseToLC);
lcRoutes.get("/completed-lc", getAllCompletedLCs);

module.exports = lcRoutes;
