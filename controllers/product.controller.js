const Product = require("../models/product.model");
const Warehouse = require("../models/warehouse.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");

async function createProduct(req, res, next) {
  try {
    const {
      name,
      productDescription,
      category,
      LC,
      supplierName,
      thickness,
      width,
      length,
      color,
      grade,
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
    const productWarehouse = await Warehouse.findOne({ _id: warehouse });
    if (!productWarehouse) {
      return next(new ApiError(400, "Warehouse not found"));
    }

    const product = await Product.create({
      name,
      category,
      LC,
      thickness,
      width,
      length,
      color,
      grade,
      quantity,
      unit,
      unitPrice,
      warehouse,
    });

    await Warehouse.findOneAndUpdate(
      { _id: warehouse },
      {
        $push: {
          product: product._id,
        },
      }
    );

    return res
      .status(201)
      .json(new ApiResponse(201, product, "Product created successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function getAllProducts(req, res, next) {
  try {
    const products = await Product.find()
      .populate("LC", "basic_info.lc_number basic_info.supplier_name financial_info.lc_amount_bdt")
      .populate("warehouse", "name location")
      .populate("category", "name description");

    return res
      .status(200)
      .json(new ApiResponse(200, products, "Products fetched successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function getProductById(req, res, next) {
  try {
    const { id } = req.params;
    const product = await Product.findById(id)
      .populate(
        "LC",
        "basic_info.lc_number basic_info.supplier_name financial_info.lc_amount_bdt"
      )
      .populate("warehouse", "name location")
      .populate("category", "name description");

    if (!product) {
      return next(new ApiError(404, "Product not found"));
    }

    return res
      .status(200)
      .json(new ApiResponse(200, product, "Product fetched successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function updateProduct(req, res, next) {
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
      .json(new ApiResponse(200, updated, "Product updated successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function deleteProduct(req, res, next) {
  try {
    const { id } = req.params;
    const deleted = await Product.findByIdAndDelete(id);

    if (!deleted) {
      return next(new ApiError(404, "Product not found"));
    }

    return res
      .status(200)
      .json(new ApiResponse(200, deleted, "Product deleted successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function getInventoryStats(_, res, next) {
  try {
    const stats = await Product.getInventoryStats();
    return res
      .status(200)
      .json(
        new ApiResponse(200, stats, "Inventory statistics fetched successfully")
      );
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function getStockStatus(_, res, next) {
  try {
    const lowStock = await Product.find({ quantity: { $gt: 0, $lt: 20 } })
      .populate("warehouse", "name location")
      .populate("LC", "basic_info.lc_number basic_info.supplier_name");

    const outOfStock = await Product.find({ quantity: 0 })
      .populate("warehouse", "name location")
      .populate("LC", "basic_info.lc_number basic_info.supplier_name");

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          { lowStock, outOfStock },
          "Low stock and out of stock products fetched successfully"
        )
      );
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

module.exports = {
  createProduct,
  getAllProducts,
  getProductById,
  updateProduct,
  deleteProduct,
  getInventoryStats,
  getStockStatus,
};
