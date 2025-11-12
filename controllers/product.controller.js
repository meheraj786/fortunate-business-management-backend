const Product = require("../models/product.model");
const Warehouse = require("../models/warehouse.model");
const Sales = require("../models/sales.model");
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

    if (!name || !category || !LC || !quantity || !unit || !unitPrice) {
      return next(new ApiError(400, "All required fields must be provided"));
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
    next(new ApiError(500, error.message));
  }
}

// New function to get all products for a specific warehouse
async function getProductsByWarehouse(req, res, next) {
  try {
    const { warehouseId } = req.params;
    const products = await Product.find({ warehouse: warehouseId })
      .populate("LC", "basic_info.lc_number basic_info.supplier_name")
      .populate("category", "name");

    return res
      .status(200)
      .json(new ApiResponse(200, products, "Products fetched successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
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
        "basic_info.lc_number basic_info.supplier_name financial_info.lc_amount_bdt"
      )
      .populate("warehouse", "name location")
      .populate("category", "name description");

    if (!product) {
      return next(
        new ApiError(404, "Product not found in this warehouse")
      );
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
    const recentSales = await Sales.find({ product: productId })
      .sort({ saleDate: -1 })
      .limit(5);

    const productWithSales = {
      ...product.toObject(),
      recentSales,
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
          productWithSales,
          "Product fetched successfully"
        )
      );
  } catch (error) {
    next(new ApiError(500, error.message));
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
    next(new ApiError(500, error.message));
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
    next(new ApiError(500, error.message));
  }
}

// (The old global functions can be kept for admin overview purposes if needed, but won't be wired to the new routes)
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
  createProductInWarehouse,
  getProductsByWarehouse,
  getProductInWarehouse,
  updateProductInWarehouse,
  deleteProductInWarehouse,
  getWarehouseInventoryStats,
  // Exporting old functions in case they are needed elsewhere
  getAllProducts,
  getStockStatus,
};