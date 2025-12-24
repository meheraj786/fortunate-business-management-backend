const Product = require("../models/product.model");
const Warehouse = require("../models/warehouse.model");
const Sales = require("../models/sales.model");
const Unit = require("../models/unit.model"); // Import Unit model
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");

// New function to create a product within a specific warehouse
async function createProductInWarehouse(req, res, next) {
  try {
    const { warehouseId } = req.params;
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
    } = req.body;

    const validationErrors = [];
    if (!name)
      validationErrors.push({ field: "name", message: "Name is required" });
    if (!category)
      validationErrors.push({
        field: "category",
        message: "Category is required",
      });
    if (!LC) validationErrors.push({ field: "LC", message: "LC is required" });
    if (!quantity)
      validationErrors.push({
        field: "quantity",
        message: "Quantity is required",
      });
    if (!unit)
      validationErrors.push({ field: "unit", message: "Unit is required" });
    if (!unitPrice)
      validationErrors.push({
        field: "unitPrice",
        message: "Unit price is required",
      });

    if (validationErrors.length > 0) {
      return next(new ApiError(400, validationErrors[0].message, validationErrors));
    }

    const existingUnit = await Unit.findById(unit);
    if (!existingUnit) {
      return next(new ApiError(404, "Unit not found"));
    }

    const productWarehouse = await Warehouse.findById(warehouseId);
    if (!productWarehouse) {
      return next(new ApiError(404, "Warehouse not found"));
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
      warehouse: warehouseId, // Assign warehouse from URL params
    });

    // Add product reference to the warehouse
    productWarehouse.product.push(product._id);
    await productWarehouse.save();

    return res
      .status(201)
      .json(new ApiResponse(201, product, "Product created successfully"));
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    next(new ApiError(500, error.message || "Something went wrong"));
  }
}

// New function to get all products for a specific warehouse
async function getProductsByWarehouse(req, res, next) {
  try {
    const { warehouseId } = req.params;
    const products = await Product.find({ warehouse: warehouseId })
      .select(
        "name category LC thickness width length color grade quantity unit unitPrice createdAt updatedAt"
      )
      .populate("category", "name")
      .populate("LC", "basicInfo.lcNumber")
      .populate("unit", "name type conversionFactor") // Temporarily populate conversionFactor
      .lean(); // Use .lean() to get plain JavaScript objects

    const productsWithStatus = products.map((product) => {
      const totalInGrams = product.quantity * (product.unit?.conversionFactor || 0);
      let stockStatus;

      // Thresholds in grams
      const LOW_STOCK_THRESHOLD = 10000; // 10 KG
      const MEDIUM_STOCK_THRESHOLD = 1000000; // 1 TON

      if (totalInGrams === 0) {
        stockStatus = "No Stock";
      } else if (totalInGrams <= LOW_STOCK_THRESHOLD) {
        stockStatus = "Low";
      } else if (totalInGrams <= MEDIUM_STOCK_THRESHOLD) {
        stockStatus = "Medium";
      } else {
        stockStatus = "OK";
      }

      // Remove conversionFactor from the populated unit object before sending the response
      if (product.unit) {
        delete product.unit.conversionFactor;
      }

      return {
        ...product,
        stockStatus,
      };
    });

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          productsWithStatus,
          "Products fetched successfully"
        )
      );
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    next(new ApiError(500, error.message || "Something went wrong"));
  }
}

// New function to get a single product, ensuring it's in the correct warehouse
async function getProductInWarehouse(req, res, next) {
  try {
    const { warehouseId, productId } = req.params;
    const product = await Product.findOne({
      _id: productId,
      warehouse: warehouseId,
    })
      .populate(
        "LC",
        { "basicInfo.lcNumber": 1, "basicInfo.supplierName": 1, "financialInfo.lcAmountBdt": 1 }
      )
      .populate("warehouse", "name location")
      .populate("category", "name description")
      .populate("unit", "name type conversionFactor")
      .lean(); // Add .lean() here

    if (!product) {
      return next(
        new ApiError(404, "Product not found in this warehouse")
      );
    }

    // Calculate stockStatus
    const totalInGrams = product.quantity * (product.unit?.conversionFactor || 0);
    let stockStatus;

    // Thresholds in grams (same as getProductsByWarehouse)
    const LOW_STOCK_THRESHOLD = 10000; // 10 KG
    const MEDIUM_STOCK_THRESHOLD = 1000000; // 1 TON

    if (totalInGrams === 0) {
      stockStatus = "No Stock";
    } else if (totalInGrams <= LOW_STOCK_THRESHOLD) {
      stockStatus = "Low";
    } else if (totalInGrams <= MEDIUM_STOCK_THRESHOLD) {
      stockStatus = "Medium";
    } else {
      stockStatus = "OK";
    }

    // The rest of the stats logic can remain the same
    const salesStats = await Sales.aggregate([
      { $match: { product: product._id } },
      {
        $group: {
          _id: "$product",
          totalUnitsSold: { $sum: "$quantity" },
          totalRevenue: { $sum: "$totalAmount" },
        },
      },
    ]);
    const totalDueInvoices = await Sales.countDocuments({
      product: productId,
      invoiceStatus: "Invoiced",
      paymentStatus: "Due payment",
    });
    const totalNotInvoiced = await Sales.countDocuments({
      product: productId,
      invoiceStatus: "Not-invoiced",
    });

    // Remove conversionFactor from the populated unit object before sending the response
    if (product.unit) {
      delete product.unit.conversionFactor;
    }

    const productWithStats = {
      ...product, // product is already a lean object
      stockStatus, // Add stockStatus here
      totalUnitsSold: salesStats[0]?.totalUnitsSold || 0,
      totalRevenue: salesStats[0]?.totalRevenue || 0,
      totalDueInvoices,
      totalNotInvoiced,
    };

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          productWithStats,
          "Product fetched successfully"
        )
      );
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    next(new ApiError(500, error.message || "Something went wrong"));
  }
}

// New function to update a product within its warehouse
async function updateProductInWarehouse(req, res, next) {
  try {
    const { warehouseId, productId } = req.params;

    // Prevent changing the warehouse via this endpoint
    if (req.body.warehouse && req.body.warehouse !== warehouseId) {
      return next(
        new ApiError(
          400,
          "Cannot change a product's warehouse from this endpoint. Please use a dedicated 'move' endpoint."
        )
      );
    }

    if (req.body.unit) {
      const existingUnit = await Unit.findById(req.body.unit);
      if (!existingUnit) {
        const validationError = {
          field: "unit",
          message: "The provided unit ID was not found",
        };
        return next(new ApiError(404, validationError.message, [validationError]));
      }
    }

    const updated = await Product.findOneAndUpdate(
      { _id: productId, warehouse: warehouseId },
      req.body,
      {
        new: true,
        runValidators: true,
      }
    );

    if (!updated) {
      return next(
        new ApiError(404, "Product not found in this warehouse")
      );
    }

    return res
      .status(200)
      .json(new ApiResponse(200, updated, "Product updated successfully"));
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    next(new ApiError(500, error.message || "Something went wrong"));
  }
}

// New function to delete a product, ensuring data consistency
async function deleteProductInWarehouse(req, res, next) {
  try {
    const { warehouseId, productId } = req.params;

    // First, ensure the product exists and is in the specified warehouse
    const product = await Product.findOne({
      _id: productId,
      warehouse: warehouseId,
    });
    if (!product) {
      return next(
        new ApiError(404, "Product not found in this warehouse")
      );
    }

    // Remove the product reference from the warehouse's product array
    await Warehouse.findByIdAndUpdate(warehouseId, {
      $pull: { product: productId },
    });

    // Then, delete the product
    const deleted = await Product.findByIdAndDelete(productId);

    return res
      .status(200)
      .json(new ApiResponse(200, deleted, "Product deleted successfully"));
  } catch (error) {
    // Note: Add transaction logic here in a real-world scenario for atomicity
    next(new ApiError(500, error.message));
  }
}

// New function for warehouse-specific inventory stats
async function getWarehouseInventoryStats(req, res, next) {
  try {
    const { warehouseId } = req.params;
    const stats = await Product.getInventoryStats(warehouseId);

    const formattedStats = {
      totalinstockproductcount: stats.inStockProductsCount,
      totalstockcount: stats.totalQuantity,
      totallowstockproductscount: stats.lowStockProductsCount,
      totalstockoutproductscount: stats.outOfStockProductsCount,
      totalproductdocuments: stats.totalProductsCount, // Including this for completeness, as it was the original 'totalProducts'
    };

    return res
      .status(200)
      .json(
        new ApiResponse(200, formattedStats, "Inventory statistics fetched successfully")
      );
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    next(new ApiError(500, error.message || "Something went wrong"));
  }
}

// (The old global functions can be kept for admin overview purposes if needed, but won't be wired to the new routes)
async function getAllProducts(req, res, next) {
  try {
    const products = await Product.find()
      .populate("LC", { "basicInfo.lcNumber": 1, "basicInfo.supplierName": 1, "financialInfo.lcAmountBdt": 1 })
      .populate("warehouse", "name location")
      .populate("category", "name description");

    return res
      .status(200)
      .json(new ApiResponse(200, products, "Products fetched successfully"));
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    next(new ApiError(500, error.message || "Something went wrong"));
  }
}

async function getStockStatus(_, res, next) {
  try {
    const lowStock = await Product.find({ quantity: { $gt: 0, $lt: 20 } })
      .populate("warehouse", "name location")
      .populate("LC", { "basicInfo.lcNumber": 1, "basicInfo.supplierName": 1 });

    const outOfStock = await Product.find({ quantity: 0 })
      .populate("warehouse", "name location")
      .populate("LC", { "basicInfo.lcNumber": 1, "basicInfo.supplierName": 1 });

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
    if (error instanceof ApiError) {
      return next(error);
    }
    next(new ApiError(500, error.message || "Something went wrong"));
  }
}

async function getProductSalesHistory(req, res, next) {
  try {
    const { productId } = req.params;
    const { page = 1, limit = 10 } = req.query; // Get page and limit from query

    const options = {
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
      sort: { saleDate: -1 },
      select:
        "customer product quantity pricePerUnit invoiceStatus paymentStatus saleDate totalAmount totalAmountToBePaid createdAt updatedAt",
    };

    const salesHistory = await Sales.paginate({ product: productId }, options);

    return res.status(200).json(
      new ApiResponse(
        200,
        {
          sales: salesHistory.docs,
          totalPages: salesHistory.totalPages,
          currentPage: salesHistory.page,
          totalItems: salesHistory.totalDocs,
        },
        "Product sales history fetched successfully"
      )
    );
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    next(new ApiError(500, error.message || "Something went wrong"));
  }
}


module.exports = {
  createProductInWarehouse,
  getProductsByWarehouse,
  getProductInWarehouse,
  updateProductInWarehouse,
  deleteProductInWarehouse,
  getWarehouseInventoryStats,
  getProductSalesHistory,
  // Exporting old functions in case they are needed elsewhere
  getAllProducts,
  getStockStatus,
};
