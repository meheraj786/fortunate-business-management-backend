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
  exportLCAsPDF,
  getLCSummary,
  getActiveLcs, // Import the new function
  searchLCSummary,
} = require("../../controllers/lc.controller");
const { authenticate } = require("../../middleware/auth.middleware");
const authorize = require("../../middleware/authorize.middleware");

const lcRoutes = express.Router();

// Existing routes
lcRoutes.post("/create-lc", upload.array("documents"), authenticate, authorize("LC", "CREATE"), createLC);
lcRoutes.get("/get-all-lc", authenticate, authorize("LC", "GET"), getAllLCs);
lcRoutes.get("/get-lc/:id", authenticate, authorize("LC", "GET"), getLCById);
lcRoutes.patch("/update-lc/:id", authenticate, authorize("LC", "UPDATE"), updateLC);
lcRoutes.delete("/delete-lc/:id", authenticate, authorize("LC", "DELETE"), deleteLC);
lcRoutes.post("/add-expense", authenticate, authorize("LC", "UPDATE"), addExpenseToLC);
lcRoutes.get("/completed-lc", authenticate, authorize("LC", "GET"), getAllCompletedLCs);
lcRoutes.get("/:lcId/documents/:filename",  downloadDocument);
lcRoutes.get("/export-lc/:id",  exportLCAsPDF);

// New routes for LC counts
lcRoutes.get("/counts/status", getLCCountsByStatus); // Get all status counts
lcRoutes.get("/counts/total", getTotalLCCount); // Get total LC count
lcRoutes.get("/active-lc", getActiveLcs);

// New route for LC summary
lcRoutes.get("/summary", getLCSummary); // Get summary of all LCs
lcRoutes.get("/summary/search", searchLCSummary);

module.exports = lcRoutes;
