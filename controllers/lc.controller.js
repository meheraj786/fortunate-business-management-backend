const crypto = require("crypto");
const fs = require("fs").promises;
const path = require("path");
const multer = require("multer");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const LC = require("../models/lc.model");

// Ensure the uploads directory exists
const uploadDir = path.join(__dirname, "../uploads");
const tempDir = path.join(uploadDir, "temp");

async function ensureDir(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }
}

ensureDir(uploadDir);
ensureDir(tempDir);

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, tempDir);
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
      lcData = JSON.parse(req.body.lc_data);
    } else {
      lcData = req.body;
    }

    const lc = new LC(lcData);

    if (req.files && req.files.length > 0) {
      const uploadedDocuments = [];
      for (const file of req.files) {
        const fileBuffer = await fs.readFile(file.path);
        const hash = crypto
          .createHash("sha256")
          .update(fileBuffer)
          .digest("hex");

        const sanitizedOriginalName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
        const storedName = `${Date.now()}-${sanitizedOriginalName}`;

        const documentData = {
          original_name: file.originalname,
          stored_name: storedName,
          mime_type: file.mimetype,
          size_bytes: file.size,
          hash_sha256: hash,
        };
        uploadedDocuments.push(documentData);
      }

      if (!lc.documents_notes) {
        lc.documents_notes = {};
      }
      lc.documents_notes.uploaded_documents = uploadedDocuments;
    }

    await lc.save();

    if (req.files && req.files.length > 0) {
      const newLcDir = path.join(uploadDir, lc._id.toString());
      await ensureDir(newLcDir);

      for (const file of req.files) {
        const oldPath = file.path;
        const newPath = path.join(newLcDir, file.filename);
        await fs.rename(oldPath, newPath);
      }
    }

    return res
      .status(201)
      .json(new ApiResponse(201, lc, "LC created successfully"));
  } catch (error) {
    if (req.files) {
      for (const file of req.files) {
        try {
          await fs.unlink(file.path);
        } catch (unlinkError) {
          console.error(
            `Failed to delete temporary file: ${file.path}`,
            unlinkError
          );
        }
      }
    }
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
    return res
      .status(200)
      .json(new ApiResponse(200, lc, "LC fetched successfully"));
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

// Get total count of LCs grouped by status

async function getLCCountsByStatus(req, res, next) {
  try {
    const counts = await LC.aggregate([
      {
        $group: {
          _id: "$basic_info.status",
          count: { $sum: 1 },
        },
      },
    ]);

    // Transform the result into a more usable format
    const statusCounts = {
      Active: 0,
      Completed: 0,
      Draft: 0,
      Cancelled: 0,
    };

    counts.forEach((item) => {
      statusCounts[item._id] = item.count;
    });

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          statusCounts,
          "LC counts by status fetched successfully"
        )
      );
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

/**
 * Get total count of all LCs (regardless of status)
 */
async function getTotalLCCount(req, res, next) {
  try {
    const totalCount = await LC.countDocuments();

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          { total: totalCount },
          "Total LC count fetched successfully"
        )
      );
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function downloadDocument(req, res, next) {
  try {
    const { lcId, filename } = req.params;

    // TODO: Add user authorization check here
    // For example, check if the logged-in user has access to this LC
    // const lc = await LC.findById(lcId);
    // if (!lc || !userHasAccess(req.user, lc)) {
    //   return next(new ApiError(403, "Unauthorized access to document"));
    // }

    const filePath = path.join(uploadDir, lcId, filename);

    await fs.access(filePath, fs.constants.F_OK);

    const mimeType = path.extname(filename).toLowerCase();
    let contentType = 'application/octet-stream'; // Default for unknown types

    // Basic MIME type detection (can be expanded)
    if (mimeType === '.pdf') contentType = 'application/pdf';
    else if (mimeType === '.jpg' || mimeType === '.jpeg') contentType = 'image/jpeg';
    else if (mimeType === '.png') contentType = 'image/png';
    else if (mimeType === '.gif') contentType = 'image/gif';
    // else if (mimeType === '.html') contentType = 'text/html';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    res.sendFile(filePath, (err) => {
      if (err) {
        if (err.code === 'ENOENT') {
          return next(new ApiError(404, "File not found"));
        } else {
          return next(new ApiError(500, "Could not download file"));
        }
      }
    });

  } catch (error) {
    if (error.code === 'ENOENT') {
      return next(new ApiError(404, "File not found"));
    }
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
  upload,
  getLCCountsByStatus,
  getTotalLCCount,
  downloadDocument,
};
