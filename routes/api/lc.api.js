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
  getLCCountsByStatus,
  getTotalLCCount,
  downloadDocument,
  exportLCAsPDF,
  getLCSummary,
  getActiveLcs,
  searchLCSummary,
  deleteDocument, // Import the new controller
} = require("../../controllers/lc.controller");
const { authenticate } = require("../../middleware/auth.middleware");
const authorize = require("../../middleware/authorize.middleware");

const lcRoutes = express.Router();

// --- Core LC Routes ---
lcRoutes.post("/create-lc", authenticate, authorize("LC", "CREATE"), upload.array("documents"), createLC);
lcRoutes.get("/get-all-lc", authenticate, authorize("LC", "GET"), getAllLCs);
lcRoutes.get("/get-lc/:id", authenticate, authorize("LC", "GET"), getLCById);
// Add multer middleware to handle file uploads during update
lcRoutes.patch("/update-lc/:id", authenticate, authorize("LC", "UPDATE"), upload.array("documents"), updateLC);
lcRoutes.delete("/delete-lc/:id", authenticate, authorize("LC", "DELETE"), deleteLC);

// --- Document Management Routes ---
// Route to get a specific document
lcRoutes.get("/:lcId/documents/:storedName", authenticate, authorize("LC", "GET"), downloadDocument);
// Route to delete a specific document
lcRoutes.delete("/delete-document/:lcId/:docId", authenticate, authorize("LC", "DELETE"), deleteDocument);


// --- Other LC-related Routes ---
lcRoutes.post("/add-expense", authenticate, authorize("LC", "UPDATE"), addExpenseToLC);
lcRoutes.get("/completed-lc", authenticate, authorize("LC", "GET"), getAllCompletedLCs);
lcRoutes.get("/export-lc/:id", authenticate, authorize("LC", "GET"), exportLCAsPDF);
lcRoutes.get("/active-lc", authenticate, authorize("LC", "GET"), getActiveLcs);

// --- Analytics & Summary Routes ---
lcRoutes.get("/summary", authenticate, authorize("LC", "GET"), getLCSummary);
lcRoutes.get("/summary/search", authenticate, authorize("LC", "GET"), searchLCSummary);
lcRoutes.get("/counts/status", authenticate, authorize("LC", "GET"), getLCCountsByStatus);
lcRoutes.get("/counts/total", authenticate, authorize("LC", "GET"), getTotalLCCount);


module.exports = lcRoutes;
