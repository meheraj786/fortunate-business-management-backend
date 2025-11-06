const LC = require("../models/lc.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

// Ensure the uploads directory exists
const uploadDir = path.join(__dirname, "../uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});

const upload = multer({ storage: storage });

async function createLC(req, res, next) {
  try {
    let lcData;
    if (req.body.lc_data) {
      // Handle multipart/form-data
      lcData = JSON.parse(req.body.lc_data);
    } else {
      // Handle application/json
      lcData = req.body;
    }

    // If there are uploaded files, add them to the document
    if (req.files && req.files.length > 0) {
      const uploadedDocuments = req.files.map((file) => file.path);
      if (!lcData.documents_notes) {
        lcData.documents_notes = {};
      }
      lcData.documents_notes.uploaded_documents = uploadedDocuments;
    }

    const lc = await LC.create(lcData);
    return res.status(201).json(new ApiResponse(201, lc, "LC created successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function getAllLCs(_, res, next) {
  try {
    const lcs = await LC.find();
    return res
      .status(200)
      .json(new ApiResponse(200, lcs, "All LCs fetched successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function getLCById(req, res, next) {
  try {
    const { id } = req.params;
    const lc = await LC.findById(id);
    if (!lc) return next(new ApiError(404, "LC not found"));
    return res.status(200).json(new ApiResponse(200, lc, "LC fetched successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function updateLC(req, res, next) {
  try {
    const { id } = req.params;
    const updated = await LC.findByIdAndUpdate(id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!updated) return next(new ApiError(404, "LC not found"));
    return res
      .status(200)
      .json(new ApiResponse(200, updated, "LC updated successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function deleteLC(req, res, next) {
  try {
    const { id } = req.params;
    const deleted = await LC.findByIdAndDelete(id);
    if (!deleted) return next(new ApiError(404, "LC not found"));
    return res
      .status(200)
      .json(new ApiResponse(200, deleted, "LC deleted successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function addExpenseToLC(req, res, next) {
  try {
    const { lcId } = req.params;
    const { description, amount, date } = req.body;

    if (!description || !amount) {
      throw new ApiError(400, "Description and amount are required");
    }

    const lc = await LC.findById(lcId);
    if (!lc) {
      throw new ApiError(404, "LC not found");
    }

    const newExpense = {
      description,
      amount,
      date: date || new Date(),
    };

    lc.expenses.push(newExpense);

    lc.totalExpense = (lc.totalExpense || 0) + amount;

    await lc.save();

    return res
      .status(200)
      .json(new ApiResponse(200, lc, "Expense added successfully"));
  } catch (error) {
    next(error);
  }
}


async function getAllCompletedLCs(_, res, next) {
    try {
      const lcs = await LC.find({ "basic_info.status": "Completed" });
      return res
        .status(200)
        .json(new ApiResponse(200, lcs, "All LCs fetched successfully"));
    } catch (error) {
      next(new ApiError(500, error.message));
    }
  }

module.exports = {
  createLC,
  getAllLCs,
  getLCById,
  updateLC,
  deleteLC,
  addExpenseToLC,
  getAllCompletedLCs,
  upload
};