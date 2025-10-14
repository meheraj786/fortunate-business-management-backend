const Product = require("../models/product.model.");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");


class ProductController {
  static async createProduct(req, res, next) {
    try {
      const {
        name,
        category,
        LC,
        size,
        color,
        quantity,
        unit,
        unitPrice,
        warehouse,
      } = req.body;

      if (
        !name ||
        !category ||
        !LC ||
        !quantity ||
        !unit ||
        !unitPrice ||
        !warehouse
      ) {
        return next(new ApiError(400, "All required fields must be provided"));
      }

      const product = await Product.create({
        name,
        category,
        LC,
        size,
        color,
        quantity,
        unit,
        unitPrice,
        warehouse,
      });

      return res
        .status(201)
        .json(new ApiResponse(product, "Product created successfully"));
    } catch (error) {
      next(new ApiError(500, error.message));
    }
  }

  static async getAllProducts(req, res, next) {
    try {
      const products = await Product.find()
        .populate("LC", "LCNumber supplier amount")
        .populate("warehouse", "name location");

      return res
        .status(200)
        .json(new ApiResponse(products, "Products fetched successfully"));
    } catch (error) {
      next(new ApiError(500, error.message));
    }
  }

  static async getProductById(req, res, next) {
    try {
      const { id } = req.params;
      const product = await Product.findById(id)
        .populate("LC", "LCNumber supplier amount")
        .populate("warehouse", "name location");

      if (!product) {
        return next(new ApiError(404, "Product not found"));
      }

      return res
        .status(200)
        .json(new ApiResponse(product, "Product fetched successfully"));
    } catch (error) {
      next(new ApiError(500, error.message));
    }
  }

  static async updateProduct(req, res, next) {
    try {
      const { id } = req.params;
      const updated = await Product.findByIdAndUpdate(id, req.body, {
        new: true,
        runValidators: true,
      });

      if (!updated) {
        return next(new ApiError(404, "Product not found"));
      }

      return res
        .status(200)
        .json(new ApiResponse(updated, "Product updated successfully"));
    } catch (error) {
      next(new ApiError(500, error.message));
    }
  }

  static async deleteProduct(req, res, next) {
    try {
      const { id } = req.params;
      const deleted = await Product.findByIdAndDelete(id);

      if (!deleted) {
        return next(new ApiError(404, "Product not found"));
      }

      return res
        .status(200)
        .json(new ApiResponse(deleted, "Product deleted successfully"));
    } catch (error) {
      next(new ApiError(500, error.message));
    }
  }

  static async getInventoryStats(req, res, next) {
    try {
      const stats = await Product.getInventoryStats();
      return res
        .status(200)
        .json(
          new ApiResponse(stats, "Inventory statistics fetched successfully")
        );
    } catch (error) {
      next(new ApiError(500, error.message));
    }
  }

  static async getStockStatus(req, res, next) {
    try {
      const lowStock = await Product.find({ quantity: { $gt: 0, $lt: 20 } })
        .populate("warehouse", "name location")
        .populate("LC", "LCNumber supplier");

      const outOfStock = await Product.find({ quantity: 0 })
        .populate("warehouse", "name location")
        .populate("LC", "LCNumber supplier");

      return res
        .status(200)
        .json(
          new ApiResponse(
            { lowStock, outOfStock },
            "Low stock and out of stock products fetched successfully"
          )
        );
    } catch (error) {
      next(new ApiError(500, error.message));
    }
  }
}

module.exports = ProductController;
