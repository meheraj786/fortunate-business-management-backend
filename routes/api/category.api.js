const express = require("express");
const {
  createCategory,
  getCategories,
  getCategoryById,
  updateCategory,
  deleteCategory,
} = require("../../controllers/category.controller");
const authorize = require("../../middleware/authorize.middleware");
const { authenticate } = require("../../middleware/auth.middleware");
const categoryRouter = express.Router();

categoryRouter.post("/create", authenticate, authorize("CATEGORY", "CREATE"), createCategory);
categoryRouter.get("/get", authenticate, authorize("CATEGORY", "GET"), getCategories);
categoryRouter.get("/get/:id", authenticate, authorize("CATEGORY", "GET"), getCategoryById);
categoryRouter.put("/update/:id", authenticate, authorize("CATEGORY", "UPDATE"), updateCategory);
categoryRouter.delete("/delete/:id", authenticate, authorize("CATEGORY", "DELETE"), deleteCategory);

module.exports = categoryRouter;
