const express = require("express");
const {
  createCategory,
  getCategories,
  getCategoryById,
  updateCategory,
  deleteCategory,
} = require("../../controllers/category.controller");
const authorize = require("../../middleware/authorize.middleware");
const { authMiddleware } = require("../../middleware/auth.middleware");
const categoryRouter = express.Router();

categoryRouter.post("/create", authMiddleware, authorize("CATEGORY", "CREATE"), createCategory);
categoryRouter.get("/get", authMiddleware, authorize("CATEGORY", "GET"), getCategories);
categoryRouter.get("/get/:id", authMiddleware, authorize("CATEGORY", "GET"), getCategoryById);
categoryRouter.put("/update/:id", authMiddleware, authorize("CATEGORY", "UPDATE"), updateCategory);
categoryRouter.delete("/delete/:id", authMiddleware, authorize("CATEGORY", "DELETE"), deleteCategory);

module.exports = categoryRouter;
