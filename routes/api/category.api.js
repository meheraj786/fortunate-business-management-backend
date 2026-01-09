const express = require("express");
const {
  createCategory,
  getCategories,
  getCategoryById,
  updateCategory,
  deleteCategory,
} = require("../../controllers/category.controller");
const { authorize } = require("../../middleware/authorize.middleware");
const { authenticate } = require("../../middleware/auth.middleware");
const { PERMISSIONS } = require("../../utils/permissions.constants");
const categoryRouter = express.Router();

categoryRouter.post(
  "/create-category",
  authenticate,
  authorize(PERMISSIONS.CATEGORY_CREATE),
  createCategory
);
categoryRouter.get(
  "/get-all-category",
  authenticate,
  authorize(PERMISSIONS.CATEGORY_VIEW),
  getCategories
);
categoryRouter.get(
  "/get-category/:id",
  authenticate,
  authorize(PERMISSIONS.CATEGORY_VIEW),
  getCategoryById
);
categoryRouter.put(
  "/update-category/:id",
  authenticate,
  authorize(PERMISSIONS.CATEGORY_UPDATE),
  updateCategory
);
categoryRouter.delete(
  "/delete-category/:id",
  authenticate,
  authorize(PERMISSIONS.CATEGORY_DELETE),
  deleteCategory
);

module.exports = categoryRouter;
