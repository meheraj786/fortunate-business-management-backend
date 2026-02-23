const mongoose = require("mongoose");
const Product = require("../models/product.model");
const Warehouse = require("../models/warehouse.model");
const Sales = require("../models/sales.model");
const Unit = require("../models/unit.model");
const LcModel = require("../models/lc.model");
const Category = require("../models/category.model");
const Trash = require("../models/trash.model");
const { ApiError } = require("../utils/ApiError");

/**
 * Validates product input data
 * @param {Object} data - Product data
 * @returns {Array} - Array of error objects
 */
const validateProductInput = (data) => {
  const errors = [];
  if (!data.name) errors.push({ field: "name", message: "Name is required" });
  if (!data.category)
    errors.push({ field: "category", message: "Category is required" });
  if (!data.LC) errors.push({ field: "LC", message: "LC is required" });
  if (data.quantity === undefined || data.quantity === null)
    errors.push({ field: "quantity", message: "Quantity is required" });
  if (!data.unit) errors.push({ field: "unit", message: "Unit is required" });
  if (!data.unitPrice)
    errors.push({ field: "unitPrice", message: "Unit price is required" });
  return errors;
};

/**
 * Creates a new product in a warehouse
 * @param {Object} data - Product data
 * @param {string} warehouseId - Warehouse ID
 * @returns {Promise<Object>} - Created product
 */
const createProduct = async (data, warehouseId) => {
  const validationErrors = validateProductInput(data);
  if (validationErrors.length > 0) {
    throw new ApiError(400, validationErrors[0].message, validationErrors);
  }

  const [existingUnit, existingCategory, existingLC, productWarehouse] =
    await Promise.all([
      Unit.findById(data.unit),
      Category.findById(data.category),
      LcModel.findById(data.LC),
      Warehouse.findById(warehouseId),
    ]);

  if (!existingUnit) throw new ApiError(404, "Unit not found");
  if (!existingCategory) throw new ApiError(404, "Category not found");
  if (!existingLC) throw new ApiError(404, "LC not found");
  if (!productWarehouse) throw new ApiError(404, "Warehouse not found");

  const product = await Product.create({
    ...data,
    warehouse: warehouseId,
  });

  // Add product reference to the warehouse
  productWarehouse.product.push(product._id);
  await productWarehouse.save();

  return product;
};

/**
 * Updates a product
 * @param {string} productId - Product ID
 * @param {string} warehouseId - Warehouse ID
 * @param {Object} data - Update data
 * @param {string} userId - User ID performing the update
 * @returns {Promise<Object>} - Updated product
 */
const updateProduct = async (productId, warehouseId, data, userId) => {
  // Prevent changing the warehouse via this endpoint
  if (data.warehouse && data.warehouse !== warehouseId) {
    throw new ApiError(
      400,
      "Cannot change a product's warehouse from this endpoint.",
    );
  }

  if (data.unit) {
    const existingUnit = await Unit.findById(data.unit);
    if (!existingUnit) throw new ApiError(404, "Unit not found");
  }

  const updatedProduct = await Product.findOneAndUpdate(
    { _id: productId, warehouse: warehouseId },
    { ...data, modifiedBy: userId },
    { new: true, runValidators: true },
  );

  if (!updatedProduct) {
    throw new ApiError(404, "Product not found in this warehouse");
  }

  return updatedProduct;
};

/**
 * Deletes a product (soft delete) and moves it to trash
 * @param {string} productId - Product ID
 * @param {string} warehouseId - Warehouse ID
 * @param {string} userId - User ID performing the delete
 */
const deleteProduct = async (productId, warehouseId, userId) => {
  // Check both the new items[] array and the legacy single-product field
  const existingSale = await Sales.findOne({
    $or: [
      { "items.product": productId },
      { product: productId }, // Legacy fallback
    ],
    isDeleted: { $ne: true },
  });

  if (existingSale) {
    throw new ApiError(
      409,
      "Cannot delete product: It is linked to existing sales records.",
    );
  }

  const product = await Product.findOne({
    _id: productId,
    warehouse: warehouseId,
  });

  if (!product) throw new ApiError(404, "Product not found in this warehouse");
  if (product.isDeleted)
    throw new ApiError(400, "Product is already in the trash.");

  const deleted = await Product.findByIdAndUpdate(productId, {
    isDeleted: true,
    deletedBy: userId,
  });

  await Trash.create({
    docId: productId,
    model: "Product",
    deletedBy: userId,
    metadata: { warehouseId: product.warehouse },
  });

  return deleted;
};

/**
 * Gets products with statistics (aggregation)
 * @param {string} warehouseId - Warehouse ID
 * @param {Object} query - Query params (search, sortBy, etc.)
 */
const getProductsWithStats = async (warehouseId, query) => {
  const {
    search,
    sortBy,
    sortOrder = "asc",
    stockStatus: stockStatusFilter,
    page = 1,
    limit = 10,
  } = query;

  const pageNum = parseInt(page, 10);
  const limitNum = parseInt(limit, 10);
  const skip = (pageNum - 1) * limitNum;

  const pipeline = [
    {
      $match: {
        warehouse: new mongoose.Types.ObjectId(warehouseId),
        isDeleted: false,
      },
    },
    // Lookups
    {
      $lookup: {
        from: "lcs",
        localField: "LC",
        foreignField: "_id",
        as: "LC",
        pipeline: [{ $match: { isDeleted: false } }],
      },
    },
    { $unwind: { path: "$LC", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: "categories",
        localField: "category",
        foreignField: "_id",
        as: "category",
        pipeline: [{ $match: { isDeleted: false } }],
      },
    },
    { $unwind: { path: "$category", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: "units",
        localField: "unit",
        foreignField: "_id",
        as: "unit",
        pipeline: [{ $match: { isDeleted: false } }],
      },
    },
    { $unwind: { path: "$unit", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: "users",
        localField: "createdBy",
        foreignField: "_id",
        as: "creator",
      },
    },
    {
      $lookup: {
        from: "users",
        localField: "modifiedBy",
        foreignField: "_id",
        as: "modifier",
      },
    },
    {
      $addFields: {
        createdBy: { $arrayElemAt: ["$creator", 0] },
        modifiedBy: { $arrayElemAt: ["$modifier", 0] },
      },
    },
    {
      $project: {
        creator: 0,
        modifier: 0,
        "createdBy.password": 0,
        "modifiedBy.password": 0,
      },
    },
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
  const LOW_STOCK_THRESHOLD = 10000;
  const MEDIUM_STOCK_THRESHOLD = 1000000;

  pipeline.push(
    {
      $addFields: {
        totalInGrams: {
          $ifNull: [{ $multiply: ["$quantity", "$unit.conversionFactor"] }, 0],
        },
      },
    },
    {
      $addFields: {
        stockStatus: {
          $switch: {
            branches: [
              { case: { $eq: ["$totalInGrams", 0] }, then: "No Stock" },
              {
                case: { $lte: ["$totalInGrams", LOW_STOCK_THRESHOLD] },
                then: "Low",
              },
              {
                case: { $lte: ["$totalInGrams", MEDIUM_STOCK_THRESHOLD] },
                then: "Medium",
              },
            ],
            default: "OK",
          },
        },
      },
    },
  );

  if (stockStatusFilter) {
    pipeline.push({ $match: { stockStatus: stockStatusFilter } });
  }

  const sort = {};
  if (sortBy) {
    sort[sortBy] = sortOrder === "desc" ? -1 : 1;
  } else {
    sort.createdAt = -1;
  }

  pipeline.push({
    $facet: {
      metadata: [{ $count: "totalDocs" }],
      docs: [
        { $sort: sort },
        { $skip: skip },
        { $limit: limitNum },
        {
          $project: {
            name: 1,
            thickness: 1,
            width: 1,
            length: 1,
            color: 1,
            grade: 1,
            quantity: 1,
            unitPrice: 1,
            createdAt: 1,
            updatedAt: 1,
            stockStatus: 1,
            category: { _id: "$category._id", name: "$category.name" },
            createdBy: { name: "$createdBy.name", email: "$createdBy.email" },
            modifiedBy: {
              name: "$modifiedBy.name",
              email: "$modifiedBy.email",
            },
            LC: {
              _id: "$LC._id",
              basicInfo: { lcNumber: "$LC.basicInfo.lcNumber" },
            },
            unit: {
              _id: "$unit._id",
              name: "$unit.name",
              type: "$unit.type",
              conversionFactor: "$unit.conversionFactor", // needed for validation
            },
          },
        },
      ],
    },
  });

  const result = await Product.aggregate(pipeline);
  const docs = result[0].docs;
  const totalDocs = result[0].metadata[0] ? result[0].metadata[0].totalDocs : 0;
  const totalPages = Math.ceil(totalDocs / limitNum);

  return {
    docs,
    totalDocs,
    limit: limitNum,
    page: pageNum,
    totalPages,
    hasNextPage: pageNum < totalPages,
    hasPrevPage: pageNum > 1,
    nextPage: pageNum < totalPages ? pageNum + 1 : null,
    prevPage: pageNum > 1 ? pageNum - 1 : null,
  };
};

/**
 * Gets a single product with stats by ID
 * @param {string} productId - Product ID
 * @param {string} warehouseId - Warehouse ID
 */
const getProductWithStatsById = async (productId, warehouseId) => {
  const pipeline = [
    {
      $match: {
        _id: new mongoose.Types.ObjectId(productId),
        warehouse: new mongoose.Types.ObjectId(warehouseId),
        isDeleted: { $ne: true },
      },
    },
    // Populate fields
    {
      $lookup: {
        from: "lcs",
        let: { lcId: "$LC" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$_id", "$$lcId"] },
                  { $eq: ["$isDeleted", false] },
                ],
              },
            },
          },
        ],
        as: "LC",
      },
    },
    {
      $lookup: {
        from: "warehouses",
        let: { warehouseId: "$warehouse" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$_id", "$$warehouseId"] },
                  { $eq: ["$isDeleted", false] },
                ],
              },
            },
          },
        ],
        as: "warehouse",
      },
    },
    {
      $lookup: {
        from: "categories",
        let: { categoryId: "$category" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$_id", "$$categoryId"] },
                  { $eq: ["$isDeleted", false] },
                ],
              },
            },
          },
        ],
        as: "category",
      },
    },
    {
      $lookup: {
        from: "units",
        let: { unitId: "$unit" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$_id", "$$unitId"] },
                  { $eq: ["$isDeleted", false] },
                ],
              },
            },
          },
        ],
        as: "unit",
      },
    },
    {
      $lookup: {
        from: "users",
        localField: "createdBy",
        foreignField: "_id",
        as: "creator",
      },
    },
    {
      $lookup: {
        from: "users",
        localField: "modifiedBy",
        foreignField: "_id",
        as: "modifier",
      },
    },
    {
      $addFields: {
        createdBy: { $arrayElemAt: ["$creator", 0] },
        modifiedBy: { $arrayElemAt: ["$modifier", 0] },
      },
    },
    {
      $project: {
        creator: 0,
        modifier: 0,
        "createdBy.password": 0,
        "modifiedBy.password": 0,
      },
    },
    { $unwind: { path: "$LC", preserveNullAndEmptyArrays: true } },
    { $unwind: { path: "$warehouse", preserveNullAndEmptyArrays: true } },
    { $unwind: { path: "$category", preserveNullAndEmptyArrays: true } },
    { $unwind: { path: "$unit", preserveNullAndEmptyArrays: true } },

    // Calculate Sales Stats
    {
      $lookup: {
        from: "sales",
        let: { productId: "$_id" },
        pipeline: [
          {
            $match: { isDeleted: { $ne: true } },
          },
          { $unwind: "$items" },
          {
            $match: {
              $expr: {
                $eq: ["$items.product", "$$productId"],
              },
            },
          },
        ],
        as: "sales",
      },
    },
    {
      $addFields: {
        totalInGrams: {
          $ifNull: [{ $multiply: ["$quantity", "$unit.conversionFactor"] }, 0],
        },
        totalUnitsSold: { $sum: "$sales.items.quantity" },
        totalRevenue: {
          $sum: {
            $map: {
              input: "$sales",
              as: "saleItem",
              in: { $multiply: ["$$saleItem.items.quantity", "$$saleItem.items.pricePerUnit"] }
            }
          }
        },
        totalDueInvoices: {
          $size: {
            $filter: {
              input: "$sales",
              as: "sale",
              cond: {
                $and: [
                  { $eq: ["$$sale.invoiceStatus", "Invoiced"] },
                  { $eq: ["$$sale.paymentStatus", "Due payment"] },
                ],
              },
            },
          },
        },
        totalNotInvoiced: {
          $size: {
            $filter: {
              input: "$sales",
              as: "sale",
              cond: { $eq: ["$$sale.invoiceStatus", "Not-invoiced"] },
            },
          },
        },
      },
    },
    {
      $addFields: {
        stockStatus: {
          $switch: {
            branches: [
              { case: { $eq: ["$totalInGrams", 0] }, then: "No Stock" },
              { case: { $lte: ["$totalInGrams", 10000] }, then: "Low" },
              {
                case: { $lte: ["$totalInGrams", 1000000] },
                then: "Medium",
              },
            ],
            default: "OK",
          },
        },
      },
    },
    {
      $project: {
        name: 1,
        productDescription: 1,
        thickness: 1,
        width: 1,
        length: 1,
        color: 1,
        grade: 1,
        quantity: 1,
        unitPrice: 1,
        supplierName: "$LC.basicInfo.supplierName",
        totalUnitsSold: 1,
        totalRevenue: 1,
        totalDueInvoices: 1,
        totalNotInvoiced: 1,
        stockStatus: 1,
        category: { id: "$category._id", name: "$category.name" },
        LC: {
          id: "$LC._id",
          basicInfo: {
            lcNumber: "$LC.basicInfo.lcNumber",
            status: "$LC.status",
            supplierName: "$LC.basicInfo.supplierName",
            country: "$LC.basicInfo.country",
          },
        },
        unit: {
          id: "$unit._id",
          name: "$unit.name",
          type: "$unit.type",
          conversionFactor: "$unit.conversionFactor", // Return conversion factor
        },
        warehouse: {
          id: "$warehouse._id",
          name: "$warehouse.name",
          location: "$warehouse.location",
          manager: "$warehouse.manager",
        },
        createdAt: 1,
        updatedAt: 1,
        createdBy: { name: "$createdBy.name", email: "$createdBy.email" },
        modifiedBy: { name: "$modifiedBy.name", email: "$modifiedBy.email" },
      },
    },
  ];

  const results = await Product.aggregate(pipeline);
  return results[0];
};

/**
 * Gets products for sale dropdown
 * @param {string} warehouseId
 * @param {string} categoryId (optional)
 */
const getProductsForSale = async (warehouseId, categoryId) => {
  const query = {
    warehouse: warehouseId,
    isDeleted: false,
    quantity: { $gt: 0 },
  };

  if (categoryId) {
    query.category = categoryId;
  }

  const products = await Product.find(query)
    .populate("unit", "name conversionFactor type")
    .select("name quantity unitPrice unit");

  return products;
};

/**
 * Gets sales history for a product
 * @param {string} warehouseId
 * @param {string} productId
 * @param {Object} queryParams
 */
const getProductSalesHistory = async (warehouseId, productId, queryParams) => {
  const { page = 1, limit = 10 } = queryParams;
  const skip = (page - 1) * limit;

  const query = {
    "items.product": productId,
    isDeleted: false,
  };

  const sales = await Sales.find(query)
    .populate("customer.customerId", "name phone")
    .populate("items.product", "name")
    .populate("items.unit", "name")
    .sort({ saleDate: -1 })
    .limit(Number(limit))
    .skip(skip);

  const total = await Sales.countDocuments(query);

  return {
    sales,
    total,
    page: Number(page),
    limit: Number(limit),
    totalPages: Math.ceil(total / limit),
  };
};

module.exports = {
  createProduct,
  updateProduct,
  deleteProduct,
  getProductsWithStats,
  getProductWithStatsById,
  getProductsForSale,
  getProductSalesHistory,
};
