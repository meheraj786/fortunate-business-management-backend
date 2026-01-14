const Product = require("../models/product.model");
const Warehouse = require("../models/warehouse.model");
const Sales = require("../models/sales.model");
const Unit = require("../models/unit.model"); // Import Unit model
const { ApiError } = require("../utils/ApiError");
const logger = require("../utils/logger");
const { ApiResponse } = require("../utils/ApiResponse");
const Trash = require("../models/trash.model");

// New function to create a product within a specific warehouse
async function createProductInWarehouse(req, res, next) {
  try {
    const { warehouseId } = req.params;
    const {
      name,
      productDescription,
      category,
      LC: lcId,
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
    if (!lcId)
      validationErrors.push({ field: "LC", message: "LC is required" });
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
      return next(
        new ApiError(400, validationErrors[0].message, validationErrors)
      );
    }

    const existingUnit = await Unit.findById(unit);
    if (!existingUnit) {
      return next(new ApiError(404, "Unit not found"));
    }

    const mongoose = require("mongoose");
    const LcModel = require("../models/lc.model");
    const Category = require("../models/category.model");

    const existingCategory = await Category.findById(category);
    if (!existingCategory) {
      return next(new ApiError(404, "Category not found"));
    }

    const existingLC = await LcModel.findById(lcId);
    if (!existingLC) {
      return next(new ApiError(404, "LC not found"));
    }

    const productWarehouse = await Warehouse.findById(warehouseId);
    if (!productWarehouse) {
      return next(new ApiError(404, "Warehouse not found"));
    }

    const product = await Product.create({
      name,
      category,
      LC: lcId,
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
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A document with the same ${field} '${value}' already exists.`
        )
      ); // Generic message
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
    next(new ApiError(500, "An unexpected error occurred. Please try again."));
  }
}

// New function to get all products for a specific warehouse
async function getProductsByWarehouse(req, res, next) {
  try {
    const { warehouseId } = req.params;
    const {
      search,
      sortBy,
      sortOrder = "asc",
      stockStatus: stockStatusFilter,
      page = 1,
      limit = 10,
    } = req.query;

    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;

    const pipeline = [];

    // Initial match for the warehouse
    const mongoose = require("mongoose");
    pipeline.push({
      $match: {
        warehouse: new mongoose.Types.ObjectId(warehouseId),
        isDeleted: false,
      },
    });

    // Lookups for related data
    pipeline.push(
      {
        $lookup: {
          from: "lcs",
          localField: "LC",
          foreignField: "_id",
          as: "LC",
          pipeline: [
            { $match: { isDeleted: false } }, // only active LC
          ],
        },
      },
      { $unwind: { path: "$LC", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "categories",
          localField: "category",
          foreignField: "_id",
          as: "category",
          pipeline: [
            { $match: { isDeleted: false } }, // only active category
          ],
        },
      },
      { $unwind: { path: "$category", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "units",
          localField: "unit",
          foreignField: "_id",
          as: "unit",
          pipeline: [
            { $match: { isDeleted: false } }, // only active units
          ],
        },
      },
      { $unwind: { path: "$unit", preserveNullAndEmptyArrays: true } }
    );
    // pipeline.push(
    //   {
    //     $lookup: {
    //       from: "lcs",
    //       localField: "LC",
    //       foreignField: "_id",
    //       as: "LC",
    //     },
    //   },
    //   { $unwind: { path: "$LC", preserveNullAndEmptyArrays: true } },
    //   {
    //     $lookup: {
    //       from: "categories",
    //       localField: "category",
    //       foreignField: "_id",
    //       as: "category",
    //     },
    //   },
    //   { $unwind: { path: "$category", preserveNullAndEmptyArrays: true } },
    //   {
    //     $lookup: {
    //       from: "units",
    //       localField: "unit",
    //       foreignField: "_id",
    //       as: "unit",
    //     },
    //   },
    //   { $unwind: { path: "$unit", preserveNullAndEmptyArrays: true } }
    // );

    // Search logic for product name and LC number
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

    // Add stock status calculation fields
    const LOW_STOCK_THRESHOLD = 10000; // 10 KG
    const MEDIUM_STOCK_THRESHOLD = 1000000; // 1 TON

    pipeline.push({
      $addFields: {
        totalInGrams: {
          $ifNull: [{ $multiply: ["$quantity", "$unit.conversionFactor"] }, 0],
        },
      },
    });

    pipeline.push({
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
    });

    // Filter by stock status
    if (stockStatusFilter) {
      pipeline.push({ $match: { stockStatus: stockStatusFilter } });
    }

    // Sorting
    const sort = {};
    if (sortBy) {
      sort[sortBy] = sortOrder === "desc" ? -1 : 1;
    } else {
      sort.createdAt = -1; // Default sort
    }

    // Facet for pagination
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
              LC: {
                _id: "$LC._id",
                basicInfo: { lcNumber: "$LC.basicInfo.lcNumber" },
              },
              unit: {
                _id: "$unit._id",
                name: "$unit.name",
                type: "$unit.type",
              },
            },
          },
        ],
      },
    });

    const result = await Product.aggregate(pipeline);

    const docs = result[0].docs;
    const totalDocs = result[0].metadata[0]
      ? result[0].metadata[0].totalDocs
      : 0;
    const totalPages = Math.ceil(totalDocs / limitNum);

    const response = {
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

    return res
      .status(200)
      .json(new ApiResponse(200, response, "Products fetched successfully"));
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A document with the same ${field} '${value}' already exists.`
        )
      ); // Generic message
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
    next(new ApiError(500, "An unexpected error occurred. Please try again."));
  }
}

// New function to get a single product, ensuring it's in the correct warehouse
async function getProductInWarehouse(req, res, next) {
  try {
    const { warehouseId, productId } = req.params;
    const mongoose = require("mongoose");

    const pipeline = [
      {
        $match: {
          _id: new mongoose.Types.ObjectId(productId),
          warehouse: new mongoose.Types.ObjectId(warehouseId),
          isDeleted: { $ne: true },
        },
      },
      // --- Populate Product Fields ---
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
      // Unwind the populated arrays
      { $unwind: { path: "$LC", preserveNullAndEmptyArrays: true } },
      { $unwind: { path: "$warehouse", preserveNullAndEmptyArrays: true } },
      { $unwind: { path: "$category", preserveNullAndEmptyArrays: true } },
      { $unwind: { path: "$unit", preserveNullAndEmptyArrays: true } },

      // --- Calculate Sales Stats ---
      {
        $lookup: {
          from: "sales",
          let: { productId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$product", "$$productId"] },
                    { $eq: ["$isDeleted", false] },
                  ],
                },
              },
            },
          ],
          as: "sales",
        },
      },

      // --- Calculate stockStatus and Final Projection ---
      {
        $addFields: {
          // Calculate stockStatus
          totalInGrams: {
            $ifNull: [
              { $multiply: ["$quantity", "$unit.conversionFactor"] },
              0,
            ],
          },
          // Calculate sales stats
          totalUnitsSold: { $sum: "$sales.quantity" },
          totalRevenue: { $sum: "$sales.totalAmount" },
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
                { case: { $lte: ["$totalInGrams", 10000] }, then: "Low" }, // 10 KG
                { case: { $lte: ["$totalInGrams", 1000000] }, then: "Medium" }, // 1 TON
              ],
              default: "OK",
            },
          },
        },
      },
      // Final cleanup & projection
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
          category: {
            id: "$category._id",
            name: "$category.name",
          },
          LC: {
            basicInfo: {
              lcNumber: "$LC.basicInfo.lcNumber",
              status: "$LC.status",
              supplierName: "$LC.basicInfo.supplierName",
              country: "$LC.basicInfo.country",
            },
          },
          unit: {
            name: "$unit.name",
            type: "$unit.type",
          },
          warehouse: {
            name: "$warehouse.name",
            location: "$warehouse.location",
            manager: "$warehouse.manager",
          },
          createdAt: 1,
          updatedAt: 1,
        },
      },
    ];

    const results = await Product.aggregate(pipeline);

    if (results.length === 0) {
      return next(new ApiError(404, "Product not found in this warehouse"));
    }

    const productWithStats = results[0];

    return res
      .status(200)
      .json(
        new ApiResponse(200, productWithStats, "Product fetched successfully")
      );
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A document with the same ${field} '${value}' already exists.`
        )
      ); // Generic message
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
    next(new ApiError(500, "An unexpected error occurred. Please try again."));
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
        return next(
          new ApiError(404, validationError.message, [validationError])
        );
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
      return next(new ApiError(404, "Product not found in this warehouse"));
    }

    return res
      .status(200)
      .json(new ApiResponse(200, updated, "Product updated successfully"));
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A document with the same ${field} '${value}' already exists.`
        )
      ); // Generic message
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
    next(new ApiError(500, "An unexpected error occurred. Please try again."));
  }
}

// New function to delete a product, ensuring data consistency
async function deleteProductInWarehouse(req, res, next) {
  try {
    const { warehouseId, productId } = req.params;

    // First, check if the product has any associated sales
    const existingSale = await Sales.findOne({
      product: productId,
      isDeleted: { $ne: true },
    });
    if (existingSale) {
      return next(
        new ApiError(
          409,
          "Cannot delete product: It is linked to existing sales records."
        )
      );
    }

    // Ensure the product exists and is in the specified warehouse
    const product = await Product.findOne({
      _id: productId,
      warehouse: warehouseId,
    });
    if (!product) {
      return next(new ApiError(404, "Product not found in this warehouse"));
    }
    if (product.isDeleted) {
      return next(new ApiError(400, "Product is already in the trash."));
    }

    // Then, soft-delete the product
    const deleted = await Product.findByIdAndUpdate(productId, {
      isDeleted: true,
    });

    if (!deleted) {
      // This case should ideally not be hit if the findOne check passes, but it's good for safety
      return next(new ApiError(404, "Product not found"));
    }

    // move to trash
    await Trash.create({
      docId: productId,
      model: "Product",
      deletedBy: req.cookies?.userId || req.user?._id || null,
      metadata: { warehouseId: product.warehouse }, // Store warehouseId in metadata
    });

    return res
      .status(200)
      .json(
        new ApiResponse(200, deleted, "Product moved to trash successfully")
      );
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A document with the same ${field} '${value}' already exists.`
        )
      ); // Generic message
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
    next(new ApiError(500, "An unexpected error occurred. Please try again."));
  }
}

// (The old global functions can be kept for admin overview purposes if needed, but won't be wired to the new routes)
async function getAllProducts(req, res, next) {
  try {
    const products = await Product.aggregate([
      {
        $match: { isDeleted: false },
        $lookup: {
          from: "lcs",
          localField: "LC",
          foreignField: "_id",
          as: "LC",
        },
      },
      {
        $lookup: {
          from: "warehouses",
          localField: "warehouse",
          foreignField: "_id",
          as: "warehouse",
        },
      },
      {
        $lookup: {
          from: "categories",
          localField: "category",
          foreignField: "_id",
          as: "category",
        },
      },
      // Unwind the populated arrays
      { $unwind: { path: "$LC", preserveNullAndEmptyArrays: true } },
      { $unwind: { path: "$warehouse", preserveNullAndEmptyArrays: true } },
      { $unwind: { path: "$category", preserveNullAndEmptyArrays: true } },
    ]);

    return res
      .status(200)
      .json(new ApiResponse(200, products, "Products fetched successfully"));
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A document with the same ${field} '${value}' already exists.`
        )
      ); // Generic message
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
    next(new ApiError(500, "An unexpected error occurred. Please try again."));
  }
}

async function getStockStatus(_, res, next) {
  try {
    const results = await Product.aggregate([
      {
        $facet: {
          lowStock: [
            { $match: { quantity: { $gt: 0, $lt: 20 }, isDeleted: false } },
            {
              $lookup: {
                from: "warehouses",
                localField: "warehouse",
                foreignField: "_id",
                as: "warehouse",
              },
            },
            {
              $lookup: {
                from: "lcs",
                localField: "LC",
                foreignField: "_id",
                as: "LC",
              },
            },
            {
              $unwind: { path: "$warehouse", preserveNullAndEmptyArrays: true },
            },
            { $unwind: { path: "$LC", preserveNullAndEmptyArrays: true } },
          ],
          outOfStock: [
            { $match: { quantity: 0, isDeleted: false } },
            {
              $lookup: {
                from: "warehouses",
                localField: "warehouse",
                foreignField: "_id",
                as: "warehouse",
              },
            },
            {
              $lookup: {
                from: "lcs",
                localField: "LC",
                foreignField: "_id",
                as: "LC",
              },
            },
            {
              $unwind: { path: "$warehouse", preserveNullAndEmptyArrays: true },
            },
            { $unwind: { path: "$LC", preserveNullAndEmptyArrays: true } },
          ],
        },
      },
    ]);

    const { lowStock, outOfStock } = results[0];

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
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A document with the same ${field} '${value}' already exists.`
        )
      ); // Generic message
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
    next(new ApiError(500, "An unexpected error occurred. Please try again."));
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
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A document with the same ${field} '${value}' already exists.`
        )
      ); // Generic message
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
    next(new ApiError(500, "An unexpected error occurred. Please try again."));
  }
}

async function getProductsForSale(req, res, next) {
  try {
    const { warehouseId } = req.params;
    const { categoryId } = req.query;
    const mongoose = require("mongoose");

    const matchStage = {
      warehouse: new mongoose.Types.ObjectId(warehouseId),
      isDeleted: false,
      quantity: { $gt: 0 }, // Only fetch products that are in stock
    };

    if (categoryId) {
      matchStage.category = new mongoose.Types.ObjectId(categoryId);
    }

    const products = await Product.aggregate([
      { $match: matchStage },
      {
        $lookup: {
          from: "units",
          localField: "unit",
          foreignField: "_id",
          as: "unit",
        },
      },
      { $unwind: { path: "$unit", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "categories",
          localField: "category",
          foreignField: "_id",
          as: "category",
          pipeline: [
            { $match: { isDeleted: false } }, // only active category
          ],
        },
      },
      { $unwind: { path: "$category", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          name: 1,
          unitPrice: 1,
          quantity: 1,
          unit: {
            _id: "$unit._id",
            name: "$unit.name",
          },
          category: {
            _id: "$category._id",
            name: "$category.name",
          },
        },
      },
      { $sort: { name: 1 } }, // Sort alphabetically by name
    ]);

    return res
      .status(200)
      .json(
        new ApiResponse(200, products, "Products for sale fetched successfully")
      );
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    logger.error(error);
    next(new ApiError(500, "An unexpected error occurred. Please try again."));
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
  getProductsForSale,
};
