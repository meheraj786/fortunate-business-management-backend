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
  getLCCountsByStatus, // Add this
  getTotalLCCount,
  downloadDocument, 
} = require("../../controllers/lc.controller");

const lcRoutes = express.Router();

// Existing routes
lcRoutes.post("/create-lc", upload.array("documents"), createLC);
lcRoutes.get("/get-all-lc", getAllLCs);
lcRoutes.get("/get-lc/:id", getLCById);
lcRoutes.patch("/update-lc/:id", updateLC);
lcRoutes.delete("/delete-lc/:id", deleteLC);
lcRoutes.post("/add-lc-expense/:lcId", addExpenseToLC);
lcRoutes.get("/completed-lc", getAllCompletedLCs);
lcRoutes.get("/:lcId/documents/:filename", downloadDocument);

// New routes for LC counts
lcRoutes.get("/counts/status", getLCCountsByStatus); // Get all status counts
lcRoutes.get("/counts/total", getTotalLCCount); // Get total LC count

module.exports = lcRoutes;
