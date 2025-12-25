const mongoose = require("mongoose");
const Trash = require("../models/trash.model");
const { ApiResponse } = require("../utils/ApiResponse");
const { ApiError } = require("../utils/ApiError");


const moveToTrash = async ({ docId, modelName, deletedBy = null }) => {
  if (!docId || !modelName) {
    throw new Error("docId and modelName are required");
  }

  await Trash.findOneAndUpdate(
    { docId, model: modelName },
    {
      docId,
      model: modelName,
      deletedBy,
      deletedAt: new Date(),
    },
    { upsert: true, new: true }
  );
};



const restoreFromTrash = async (req, res, next) => {
  try {
    const trash = await Trash.findById(req.params.id);

    if (!trash) {
      return next(new ApiError(404, "Trash item not found"));
    }

    const Model = mongoose.model(trash.model);

    const restoredDoc = await Model.findByIdAndUpdate(
      trash.docId,
      { isDeleted: false },
      { new: true }
    );

    if (!restoredDoc) {
      await trash.deleteOne();
      return next(new ApiError(404, "Original document not found, trash record removed"));
    }

    await trash.deleteOne();

    res.status(200).json(
      new ApiResponse(
        200, 
        restoredDoc, 
        `${trash.model} restored successfully`
      )
    );
  } catch (err) {
    console.error("Restore error:", err);
    next(new ApiError(500, "Failed to restore item"));
  }
};

module.exports = { restoreFromTrash };


const getAllTrash = async (req, res) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.model) filter.model = req.query.model;

    const [trash, total] = await Promise.all([
      Trash.find(filter)
        .populate("deletedBy", "name email")
        .sort({ deletedAt: -1 })
        .skip(skip)
        .limit(limit),
      Trash.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: {
        trash,
        total,
        page,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error("Trash fetch error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to load trash",
    });
  }
};


const deleteTrashPermanently = async (req, res) => {
  try {
    const trash = await Trash.findById(req.params.id);

    if (!trash) {
      return res.status(404).json({
        success: false,
        message: "Trash item not found",
      });
    }

    await trash.deleteOne();

    res.json({
      success: true,
      message: "Trash entry removed permanently",
    });
  } catch (err) {
    console.error("Permanent delete error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to delete trash item",
    });
  }
};

module.exports = {
  moveToTrash,
  restoreFromTrash,
  getAllTrash,
  deleteTrashPermanently,
};
