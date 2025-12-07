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

categoryRouter.post("/create",  createCategory);
categoryRouter.get("/get",  getCategories);
categoryRouter.get("/get/:id",  getCategoryById);
categoryRouter.put("/update/:id",  updateCategory);
categoryRouter.delete("/delete/:id",  deleteCategory);

module.exports = categoryRouter;
