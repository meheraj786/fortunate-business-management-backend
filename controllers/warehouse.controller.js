const Warehouse = require("../models/warehouse.model");
const Product = require("../models/product.model");
const Trash = require("../models/trash.model");
const User = require("../models/user.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const mongoose = require("mongoose");

/* ================= CREATE WAREHOUSE ================= */
const createWarehouse = async (req, res, next) => {
  try {
    const { name, location } = req.body;
    const warehouse = await Warehouse.create({ name, location });
    return res.status(201).json(new ApiResponse(201, warehouse, "Warehouse created successfully"));
  } catch (error) {
    if (error.code === 11000) {
      return next(new ApiError(409, "A warehouse with this name already exists."));
    }
    next(new ApiError(500, error.message || "Internal Server Error"));
  }
};

/* ================= GET ALL WAREHOUSES (Access Controlled) ================= */
const getAllWarehouses = async (req, res, next) => {
  try {
    // Auth Middleware থেকে ইউজার ইনফো নেওয়ার চেষ্টা
    const userId = req.user?._id || req.cookies?.userId;
    const userRole = req.user?.roleName || req.cookies?.role;

    let accessFilter = { isDeleted: { $ne: true } };

    // যদি ইউজার SUPER_ADMIN না হয়, তবে তার প্রোফাইল থেকে ওয়্যারহাউস আইডি নিতে হবে
    if (userRole !== "SUPER_ADMIN") {
      if (!userId) {
        return next(new ApiError(401, "Unauthorized access. User ID missing."));
      }

      const user = await User.findById(userId);
      if (!user) {
        return next(new ApiError(404, "User not found."));
      }

      // ইউজারকে যেসব ওয়্যারহাউস এসাইন করা হয়েছে শুধু সেগুলোই ফিল্টার হবে
      accessFilter._id = { $in: user.warehouse || [] };
    }

    const results = await Warehouse.aggregate([
      { $match: accessFilter },
      {
        $facet: {
          warehouses: [
            {
              $lookup: {
                from: "products",
                localField: "_id",
                foreignField: "warehouse",
                pipeline: [{ $match: { isDeleted: { $ne: true } } }],
                as: "products",
              },
            },
            {
              $lookup: {
                from: "users",
                localField: "manager",
                foreignField: "_id",
                as: "manager",
              },
            },
            {
              $addFields: {
                stats: {
                  totalProducts: { $size: "$products" },
                  totalInStock: {
                    $size: {
                      $filter: {
                        input: "$products",
                        as: "product",
                        cond: { $gt: ["$$product.quantity", 0] },
                      },
                    },
                  },
                  totalLowStock: {
                    $size: {
                      $filter: {
                        input: "$products",
                        as: "product",
                        cond: {
                          $and: [
                            { $gt: ["$$product.quantity", 0] },
                            { $lt: ["$$product.quantity", 20] },
                          ],
                        },
                      },
                    },
                  },
                  totalStockOut: {
                    $size: {
                      $filter: {
                        input: "$products",
                        as: "product",
                        cond: { $eq: ["$$product.quantity", 0] },
                      },
                    },
                  },
                },
              },
            },
            { $project: { products: 0 } },
          ],
          globalStats: [
            {
              $lookup: {
                from: "products",
                localField: "_id",
                foreignField: "warehouse",
                pipeline: [{ $match: { isDeleted: { $ne: true } } }],
                as: "products",
              },
            },
            { $unwind: "$products" },
            {
              $group: {
                _id: null,
                totalproducts: { $sum: 1 },
                "Total In-stock": { $sum: { $cond: [{ $gt: ["$products.quantity", 0] }, 1, 0] } },
                "total lowstock": {
                  $sum: {
                    $cond: [
                      { $and: [{ $gt: ["$products.quantity", 0] }, { $lt: ["$products.quantity", 20] }] },
                      1,
                      0,
                    ],
                  },
                },
                "Total outofstock": { $sum: { $cond: [{ $eq: ["$products.quantity", 0] }, 1, 0] } },
              },
            },
            { $project: { _id: 0 } },
          ],
        },
      },
    ]);

    const response = {
      warehouses: results[0].warehouses || [],
      stats: results[0].globalStats[0] || {
        totalproducts: 0,
        "Total In-stock": 0,
        "total lowstock": 0,
        "Total outofstock": 0,
      },
    };

    return res.status(200).json(new ApiResponse(200, response, "Warehouses fetched successfully"));
  } catch (error) {
    next(new ApiError(500, error.message || "Internal Server Error"));
  }
};

/* ================= GET WAREHOUSE BY ID ================= */
const getWarehouseById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user?._id || req.cookies?.userId;
    const userRole = req.user?.roleName || req.cookies?.role;

    // Access Check for non-superadmin
    if (userRole !== "SUPER_ADMIN") {
      const user = await User.findById(userId);
      const hasAccess = user?.warehouse?.some((whId) => whId.toString() === id);
      if (!hasAccess) {
        return next(new ApiError(403, "You do not have access to this warehouse."));
      }
    }

    const results = await Warehouse.aggregate([
      { $match: { _id: new mongoose.Types.ObjectId(id), isDeleted: { $ne: true } } },
      {
        $lookup: {
          from: "users",
          localField: "manager",
          foreignField: "_id",
          as: "manager",
        },
      },
      {
        $lookup: {
          from: "products",
          localField: "_id",
          foreignField: "warehouse",
          pipeline: [{ $match: { isDeleted: { $ne: true } } }],
          as: "products",
        },
      },
      {
        $addFields: {
          manager: { $arrayElemAt: ["$manager", 0] },
          stats: {
            totalProducts: { $size: "$products" },
            totalInStock: {
              $size: {
                $filter: {
                  input: "$products",
                  as: "product",
                  cond: { $gt: ["$$product.quantity", 0] },
                },
              },
            },
            totalLowStock: {
              $size: {
                $filter: {
                  input: "$products",
                  as: "product",
                  cond: {
                    $and: [
                      { $gt: ["$$product.quantity", 0] },
                      { $lt: ["$$product.quantity", 20] },
                    ],
                  },
                },
              },
            },
            totalStockOut: {
              $size: {
                $filter: {
                  input: "$products",
                  as: "product",
                  cond: { $eq: ["$$product.quantity", 0] },
                },
              },
            },
          },
        },
      },
      { $project: { products: 0, "manager.password": 0 } },
    ]);

    if (!results.length) return next(new ApiError(404, "Warehouse not found"));
    return res.status(200).json(new ApiResponse(200, results[0], "Warehouse fetched successfully"));
  } catch (error) {
    next(new ApiError(500, error.message || "Internal Server Error"));
  }
};

/* ================= UPDATE WAREHOUSE ================= */
const updateWarehouse = async (req, res, next) => {
  try {
    const { id } = req.params;
    const warehouse = await Warehouse.findOneAndUpdate(
      { _id: id, isDeleted: { $ne: true } },
      req.body,
      { new: true, runValidators: true }
    ).populate("manager");

    if (!warehouse) return next(new ApiError(404, "Warehouse not found"));
    return res.status(200).json(new ApiResponse(200, warehouse, "Warehouse updated successfully"));
  } catch (error) {
    if (error.code === 11000) {
      return next(new ApiError(409, "A warehouse with this name already exists."));
    }
    next(new ApiError(500, error.message || "Internal Server Error"));
  }
};

/* ================= DELETE WAREHOUSE (Soft Delete) ================= */
const deleteWarehouse = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const deletedBy = req.user?._id || req.cookies?.userId || null;

    const warehouse = await Warehouse.findOne({ _id: id, isDeleted: { $ne: true } }).session(session);
    if (!warehouse) throw new ApiError(404, "Warehouse not found");

    // চেক করা হচ্ছে কোনো প্রোডাক্ট আছে কি না যা ডিলিট করা হয়নি
    const activeProducts = await Product.countDocuments({ warehouse: id, isDeleted: { $ne: true } }).session(session);
    if (activeProducts > 0) {
      throw new ApiError(400, "Cannot delete warehouse with active products. Move or delete them first.");
    }

    warehouse.isDeleted = true;
    await warehouse.save({ session });

    await Trash.create([{
      docId: warehouse._id,
      model: "Warehouse",
      deletedBy
    }], { session });

    await session.commitTransaction();
    session.endSession();

    return res.status(200).json(new ApiResponse(200, {}, "Warehouse moved to trash successfully"));
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    next(error);
  }
};

module.exports = {
  createWarehouse,
  getAllWarehouses,
  getWarehouseById,
  updateWarehouse,
  deleteWarehouse,
};