const express = require("express");
const categoryRouter = express.Router();
const {
  createCategory,
  getCategories,
  getCategoryById,
  updateCategory,
  deleteCategory,
} = require("../controllers/category.controller");

categoryRouter.post("/create", createCategory);
categoryRouter.get("/get", getCategories);
categoryRouter.get("/get/:id", getCategoryById);
categoryRouter.put("/update/:id", updateCategory);
categoryRouter.delete("/delete/:id", deleteCategory);

module.exports = categoryRouter;
