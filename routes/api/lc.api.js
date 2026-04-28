const express = require("express");
const {
  createLC,
  getAllLCs,
  getLCById,
  updateLC,
  updateLCStatus,
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
  deleteDocument,
} = require("../../controllers/lc.controller");
const { authenticate } = require("../../middleware/auth.middleware");
const { authorize } = require("../../middleware/authorize.middleware");
const { PERMISSIONS } = require("../../utils/permissions.constants");

const lcRoutes = express.Router();

// --- Core LC Routes ---
lcRoutes.post(
  "/create-lc",
  authenticate,
  authorize(PERMISSIONS.LC_CREATE),
  upload.array("documents"),
  createLC,
);
lcRoutes.get(
  "/get-lc/:id",
  authenticate,
  authorize(PERMISSIONS.LC_VIEW_DETAILS),
  getLCById,
);
lcRoutes.patch(
  "/update-lc/:id",
  authenticate,
  authorize(PERMISSIONS.LC_UPDATE),
  upload.array("documents"),
  updateLC,
);
lcRoutes.patch(
  "/update-status/:id",
  authenticate,
  authorize(PERMISSIONS.LC_UPDATE),
  updateLCStatus,
);
lcRoutes.delete(
  "/delete-lc/:id",
  authenticate,
  authorize(PERMISSIONS.LC_DELETE),
  deleteLC,
);

// --- Document Management Routes ---
lcRoutes.get(
  "/:lcId/documents/:storedName",
  authenticate,
  authorize(PERMISSIONS.LC_VIEW_DETAILS),
  downloadDocument,
);
lcRoutes.delete(
  "/delete-document/:lcId/:docId",
  authenticate,
  authorize(PERMISSIONS.LC_DELETE),
  deleteDocument,
);

// --- Other LC-related Routes ---
lcRoutes.post(
  "/add-expense",
  authenticate,
  authorize(PERMISSIONS.LC_UPDATE),
  addExpenseToLC,
);
lcRoutes.get("/completed-lc", authenticate, getAllCompletedLCs);
lcRoutes.get(
  "/export-lc/:id",
  authenticate,
  authorize(PERMISSIONS.LC_EXPORT_PDF),
  exportLCAsPDF,
);

// --- Analytics & Summary Routes ---
lcRoutes.get(
  "/summary",
  authenticate,
  authorize(PERMISSIONS.LC_VIEW_TABLE),
  getLCSummary,
);
lcRoutes.get(
  "/summary/search",
  authenticate,
  authorize(PERMISSIONS.LC_VIEW_TABLE),
  searchLCSummary,
);
lcRoutes.get(
  "/counts/status",
  authenticate,
  authorize(PERMISSIONS.LC_VIEW_TABLE),
  getLCCountsByStatus,
);
lcRoutes.get(
  "/active-lc",
  authenticate,
  authorize(PERMISSIONS.LC_VIEW_TABLE),
  getActiveLcs,
);

module.exports = lcRoutes;
