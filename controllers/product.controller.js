const productService = require("../services/product.service");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const logger = require("../utils/logger");

// New function to create a product within a specific warehouse
async function createProductInWarehouse(req, res, next) {
  try {
    const { warehouseId } = req.params;
    const productData = {
      ...req.body,
      createdBy: req.user?._id || null,
    };
    const product = await productService.createProduct(
      productData,
      warehouseId,
    );

    return res
      .status(201)
      .json(new ApiResponse(201, product, "Product created successfully"));
  } catch (error) {
    if (error instanceof ApiError) return next(error);

    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A document with the same ${field} '${value}' already exists.`,
        ),
      );
    }
    // Handle Mongoose validation errors
    if (error.name === "ValidationError") {
      const firstErrorField = Object.keys(error.errors)[0];
      let userFriendlyMessage = "Validation failed.";
      if (firstErrorField) {
        userFriendlyMessage = `The field ${firstErrorField} is required.`;
      }
      return next(new ApiError(400, userFriendlyMessage, error.errors));
    }
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
}

// New function to get all products for a specific warehouse
async function getProductsByWarehouse(req, res, next) {
  try {
    const { warehouseId } = req.params;
    const result = await productService.getProductsWithStats(
      warehouseId,
      req.query,
    );

    return res
      .status(200)
      .json(new ApiResponse(200, result, "Products fetched successfully"));
  } catch (error) {
    if (error instanceof ApiError) return next(error);
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
}

// New function to get a single product, ensuring it's in the correct warehouse
async function getProductInWarehouse(req, res, next) {
  try {
    const { warehouseId, productId } = req.params;
    const product = await productService.getProductWithStatsById(
      productId,
      warehouseId,
    );

    if (!product) {
      return next(new ApiError(404, "Product not found in this warehouse"));
    }

    return res
      .status(200)
      .json(new ApiResponse(200, product, "Product fetched successfully"));
  } catch (error) {
    if (error instanceof ApiError) return next(error);
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
}

// New function to update a product within its warehouse
async function updateProductInWarehouse(req, res, next) {
  try {
    const { warehouseId, productId } = req.params;
    const userId = req.user?._id || null;
    const updated = await productService.updateProduct(
      productId,
      warehouseId,
      req.body,
      userId,
    );

    return res
      .status(200)
      .json(new ApiResponse(200, updated, "Product updated successfully"));
  } catch (error) {
    if (error instanceof ApiError) return next(error);
    // Handle specific mongo errors similarly if needed
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A document with the same ${field} '${value}' already exists.`,
        ),
      );
    }
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
}

// New function to delete a product, ensuring data consistency
async function deleteProductInWarehouse(req, res, next) {
  try {
    const { warehouseId, productId } = req.params;
    const userId = req.cookies?.userId || req.user?._id || null;

    const deleted = await productService.deleteProduct(
      productId,
      warehouseId,
      userId,
    );

    return res
      .status(200)
      .json(
        new ApiResponse(200, deleted, "Product moved to trash successfully"),
      );
  } catch (error) {
    if (error instanceof ApiError) return next(error);
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
}

async function getProductsForSale(req, res, next) {
  try {
    const { warehouseId } = req.params;
    const { category } = req.query;
    const products = await productService.getProductsForSale(
      warehouseId,
      category,
    );
    return res
      .status(200)
      .json(new ApiResponse(200, products, "Products fetched successfully"));
  } catch (error) {
    next(error);
  }
}

async function getProductSalesHistory(req, res, next) {
  try {
    const { warehouseId, productId } = req.params;
    const result = await productService.getProductSalesHistory(
      warehouseId,
      productId,
      req.query,
    );
    return res
      .status(200)
      .json(new ApiResponse(200, result, "Sales history fetched successfully"));
  } catch (error) {
    next(error);
  }
}

module.exports = {
  createProductInWarehouse,
  getProductsByWarehouse,
  getProductInWarehouse,
  updateProductInWarehouse,
  deleteProductInWarehouse,
  getProductsForSale,
  getProductSalesHistory,
};
