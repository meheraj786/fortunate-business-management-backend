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
} = require("../../controllers/lc.controller");
const { authMiddleware } = require("../../middleware/auth.middleware");
const authorize = require("../../middleware/authorize.middleware");

const lcRoutes = express.Router();

// Existing routes
lcRoutes.post("/create-lc", upload.array("documents"), authMiddleware, authorize("LC", "CREATE"), createLC);
lcRoutes.get("/get-all-lc", authMiddleware, authorize("LC", "GET"), getAllLCs);
lcRoutes.get("/get-lc/:id", authMiddleware, authorize("LC", "GET"), getLCById);
lcRoutes.patch("/update-lc/:id", authMiddleware, authorize("LC", "UPDATE"), updateLC);
lcRoutes.delete("/delete-lc/:id", authMiddleware, authorize("LC", "DELETE"), deleteLC);
lcRoutes.post("/add-lc-expense/:lcId", authMiddleware, authorize("LC", "UPDATE"), addExpenseToLC);
lcRoutes.get("/completed-lc", authMiddleware, authorize("LC", "GET"), getAllCompletedLCs);
lcRoutes.get("/:lcId/documents/:filename",  downloadDocument);
lcRoutes.get("/export-lc/:id",  exportLCAsPDF);

// New routes for LC counts
lcRoutes.get("/counts/status", getLCCountsByStatus); // Get all status counts
lcRoutes.get("/counts/total", getTotalLCCount); // Get total LC count
lcRoutes.get("/active-lc", getActiveLcs);

// New route for LC summary
lcRoutes.get("/summary", getLCSummary); // Get summary of all LCs

module.exports = lcRoutes;
