const Product = require("../models/product.model");
const Warehouse = require("../models/warehouse.model");
const Sales = require("../models/sales.model");
const Unit = require("../models/unit.model");
const Trash = require("../models/trash.model"); // Import Trash model
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const mongoose = require("mongoose");

/* ================= CREATE PRODUCT ================= */
async function createProductInWarehouse(req, res, next) {
  try {
    const { warehouseId } = req.params;
    const {
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
    } = req.body;

    const existingUnit = await Unit.findById(unit);
    if (!existingUnit) return next(new ApiError(404, "Unit not found"));

    const productWarehouse = await Warehouse.findById(warehouseId);
    if (!productWarehouse) return next(new ApiError(404, "Warehouse not found"));

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
      warehouse: warehouseId,
    });

    // Add reference to warehouse
    productWarehouse.product.push(product._id);
    await productWarehouse.save();

    res.status(201).json(new ApiResponse(201, product, "Product created successfully"));
  } catch (error) {
    next(error);
  }
}

/* ================= GET BY WAREHOUSE (Filtered) ================= */
async function getProductsByWarehouse(req, res, next) {
  try {
    const { warehouseId } = req.params;
    const { search, sortBy, sortOrder = "asc", stockStatus: stockStatusFilter, page = 1, limit = 10 } = req.query;

    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;

    const pipeline = [
      {
        $match: { 
          warehouse: new mongoose.Types.ObjectId(warehouseId),
          isDeleted: { $ne: true } // Filter out deleted
        }
      },
      {
        $lookup: { from: "lcs", localField: "LC", foreignField: "_id", as: "LC" }
      },
      { $unwind: { path: "$LC", preserveNullAndEmptyArrays: true } },
      {
        $lookup: { from: "categories", localField: "category", foreignField: "_id", as: "category" }
      },
      { $unwind: { path: "$category", preserveNullAndEmptyArrays: true } },
      {
        $lookup: { from: "units", localField: "unit", foreignField: "_id", as: "unit" }
      },
      { $unwind: { path: "$unit", preserveNullAndEmptyArrays: true } }
    ];

    if (search) {
      pipeline.push({
        $match: {
          $or: [
            { name: { $regex: search, $options: "i" } },
            { "LC.basicInfo.lcNumber": { $regex: search, $options: "i" } },
          ],
        },
      });
    }

    // Stock Status Calculation
    pipeline.push({
      $addFields: {
        totalInGrams: { $ifNull: [{ $multiply: ["$quantity", "$unit.conversionFactor"] }, 0] },
      },
    });

    pipeline.push({
      $addFields: {
        stockStatus: {
          $switch: {
            branches: [
              { case: { $eq: ["$totalInGrams", 0] }, then: "No Stock" },
              { case: { $lte: ["$totalInGrams", 10000] }, then: "Low" },
              { case: { $lte: ["$totalInGrams", 1000000] }, then: "Medium" },
            ],
            default: "OK",
          },
        },
      },
    });

    if (stockStatusFilter) {
      pipeline.push({ $match: { stockStatus: stockStatusFilter } });
    }

    const sort = {};
    if (sortBy) sort[sortBy] = sortOrder === "desc" ? -1 : 1;
    else sort.createdAt = -1;

    pipeline.push({
      $facet: {
        metadata: [{ $count: "totalDocs" }],
        docs: [
          { $sort: sort },
          { $skip: skip },
          { $limit: limitNum },
          {
            $project: {
              name: 1, thickness: 1, width: 1, length: 1, color: 1, grade: 1, quantity: 1, unitPrice: 1, stockStatus: 1,
              category: { _id: "$category._id", name: "$category.name" },
              LC: { _id: "$LC._id", basicInfo: { lcNumber: "$LC.basicInfo.lcNumber" } },
              unit: { _id: "$unit._id", name: "$unit.name", type: "$unit.type" },
            },
          },
        ],
      },
    });

    const result = await Product.aggregate(pipeline);
    const docs = result[0].docs;
    const totalDocs = result[0].metadata[0]?.totalDocs || 0;

    res.status(200).json(new ApiResponse(200, {
      docs, totalDocs, limit: limitNum, page: pageNum, totalPages: Math.ceil(totalDocs / limitNum)
    }, "Products fetched successfully"));
  } catch (error) {
    next(error);
  }
}

/* ================= GET PRODUCT IN WAREHOUSE (Filtered) ================= */
async function getProductInWarehouse(req, res, next) {
  try {
    const { warehouseId, productId } = req.params;

    const pipeline = [
      {
        $match: {
          _id: new mongoose.Types.ObjectId(productId),
          warehouse: new mongoose.Types.ObjectId(warehouseId),
          isDeleted: { $ne: true } // Filter out deleted
        },
      },
      {
        $lookup: { from: "lcs", localField: "LC", foreignField: "_id", as: "LC" },
      },
      { $unwind: { path: "$LC", preserveNullAndEmptyArrays: true } },
      {
        $lookup: { from: "units", localField: "unit", foreignField: "_id", as: "unit" },
      },
      { $unwind: { path: "$unit", preserveNullAndEmptyArrays: true } },
      {
        $lookup: { from: "sales", localField: "_id", foreignField: "product", as: "sales" },
      },
      {
        $addFields: {
          totalUnitsSold: { $sum: "$sales.quantity" },
          totalRevenue: { $sum: "$sales.totalAmount" },
          totalInGrams: { $ifNull: [{ $multiply: ["$quantity", "$unit.conversionFactor"] }, 0] },
        },
      },
      {
        $addFields: {
          stockStatus: {
            $switch: {
              branches: [
                { case: { $eq: ["$totalInGrams", 0] }, then: "No Stock" },
                { case: { $lte: ["$totalInGrams", 10000] }, then: "Low" },
              ],
              default: "OK",
            },
          },
        },
      },
      { $project: { sales: 0, totalInGrams: 0 } },
    ];

    const results = await Product.aggregate(pipeline);
    if (!results.length) return next(new ApiError(404, "Product not found"));

    res.status(200).json(new ApiResponse(200, results[0], "Product fetched successfully"));
  } catch (error) {
    next(error);
  }
}

/* ================= UPDATE PRODUCT (Filtered) ================= */
async function updateProductInWarehouse(req, res, next) {
  try {
    const { warehouseId, productId } = req.params;

    const updated = await Product.findOneAndUpdate(
      { _id: productId, warehouse: warehouseId, isDeleted: { $ne: true } },
      req.body,
      { new: true, runValidators: true }
    );

    if (!updated) return next(new ApiError(404, "Product not found"));

    res.status(200).json(new ApiResponse(200, updated, "Product updated successfully"));
  } catch (error) {
    next(error);
  }
}

/* ================= SOFT DELETE & TRASH ================= */
async function deleteProductInWarehouse(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { warehouseId, productId } = req.params;
    const deletedBy = req.cookies?.userId || req.user?._id || null;

    // 1. Soft delete the product
    const product = await Product.findOneAndUpdate(
      { _id: productId, warehouse: warehouseId, isDeleted: { $ne: true } },
      { isDeleted: true },
      { new: true, session }
    );

    if (!product) {
      throw new ApiError(404, "Product not found in this warehouse");
    }

    // 2. Remove from warehouse array
    await Warehouse.findByIdAndUpdate(warehouseId, {
      $pull: { product: productId },
    }, { session });

    // 3. Create Trash entry
    await Trash.create([{
      docId: product._id,
      model: "Product",
      deletedBy,
    }], { session });

    await session.commitTransaction();
    session.endSession();

    res.status(200).json(new ApiResponse(200, product, "Product moved to trash successfully"));
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    next(error);
  }
}

/* ================= ALL PRODUCTS (Admin View - Filtered) ================= */
async function getAllProducts(req, res, next) {
  try {
    const products = await Product.aggregate([
      { $match: { isDeleted: { $ne: true } } }, // Filter out deleted
      {
        $lookup: { from: "lcs", localField: "LC", foreignField: "_id", as: "LC" },
      },
      {
        $lookup: { from: "warehouses", localField: "warehouse", foreignField: "_id", as: "warehouse" },
      },
      { $unwind: { path: "$LC", preserveNullAndEmptyArrays: true } },
      { $unwind: { path: "$warehouse", preserveNullAndEmptyArrays: true } },
    ]);

    res.status(200).json(new ApiResponse(200, products, "Products fetched successfully"));
  } catch (error) {
    next(error);
  }
}

/* ================= STOCK STATUS (Filtered) ================= */
async function getStockStatus(_, res, next) {
  try {
    const results = await Product.aggregate([
      {
        $facet: {
          lowStock: [
            { $match: { isDeleted: { $ne: true }, quantity: { $gt: 0, $lt: 20 } } },
            { $lookup: { from: "warehouses", localField: "warehouse", foreignField: "_id", as: "warehouse" } },
            { $unwind: "$warehouse" }
          ],
          outOfStock: [
            { $match: { isDeleted: { $ne: true }, quantity: 0 } },
            { $lookup: { from: "warehouses", localField: "warehouse", foreignField: "_id", as: "warehouse" } },
            { $unwind: "$warehouse" }
          ],
        },
      },
    ]);

    res.status(200).json(new ApiResponse(200, results[0], "Stock status fetched"));
  } catch (error) {
    next(error);
  }
}

/* ================= SALES HISTORY ================= */
async function getProductSalesHistory(req, res, next) {
  try {
    const { productId } = req.params;
    
    // Check if product exists and not deleted
    const product = await Product.findOne({ _id: productId, isDeleted: { $ne: true } });
    if (!product) return next(new ApiError(404, "Product not found"));

    const { page = 1, limit = 10 } = req.query;
    const options = {
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
      sort: { saleDate: -1 },
    };

    const salesHistory = await Sales.paginate({ product: productId }, options);

    res.status(200).json(new ApiResponse(200, {
      sales: salesHistory.docs,
      totalPages: salesHistory.totalPages,
      currentPage: salesHistory.page,
      totalItems: salesHistory.totalDocs,
    }, "Sales history fetched"));
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
  getProductSalesHistory,
  getAllProducts,
  getStockStatus,
};