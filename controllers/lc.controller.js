const crypto = require("crypto");
const fs = require("fs").promises;
const path = require("path");
const multer = require("multer");
const { generateLCPDF } = require("../utils/LC_pdfGenerator");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const LC = require("../models/lc.model");
const Unit = require("../models/unit.model"); // Import Unit model
const Account = require("../models/account.model"); // Import Account model explicitly
require("../models/account.model"); // Ensure Account model is registered for population

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
    // Handle data sent as a stringified field in multipart/form-data
    if (req.body.lcData) {
      lcData = JSON.parse(req.body.lcData);
    } else if (req.body.lc_data) {
      // Also check for snake_case
      lcData = JSON.parse(req.body.lc_data);
    } else {
      lcData = req.body;
    }

    // Clean up empty accountId in costs to prevent CastError
    const costCleaner = (cost) => {
      if (!cost.accountId) {
        cost.accountId = null;
      }
      return cost;
    };

    const sectionsWithCosts = [
      "financialInfo",
      "shippingCustomsInfo",
      "agentTransportInfo",
      "otherExpenses",
    ];
    sectionsWithCosts.forEach((section) => {
      if (lcData[section] && lcData[section].costs) {
        lcData[section].costs = lcData[section].costs.map(costCleaner);
      }
    });

    // Add validation for productInfo.quantityUnit
    if (lcData.productInfo && Array.isArray(lcData.productInfo)) {
      for (const product of lcData.productInfo) {
        if (product.quantityUnit) {
          // If product.quantityUnit is an object, extract the ID
          if (typeof product.quantityUnit === "object" && product.quantityUnit.id) {
            product.quantityUnit = product.quantityUnit.id;
          }
          const existingUnit = await Unit.findById(product.quantityUnit);
          if (!existingUnit) {
            return next(
              new ApiError(400, "Validation failed", [
                {
                  field: "quantityUnit",
                  message: `Unit with ID ${product.quantityUnit} not found for product ${product.itemName}`,
                },
              ])
            );
          }
        }
      }
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

        const sanitizedOriginalName = file.originalname.replace(
          /[^a-zA-Z0-9.-]/g,
          "_"
        );
        const storedName = `${Date.now()}-${sanitizedOriginalName}`;

        const documentData = {
          originalName: file.originalname,
          storedName: storedName,
          mimeType: file.mimetype,
          sizeBytes: file.size,
          hashSha256: hash,
        };
        uploadedDocuments.push(documentData);
      }

      if (!lc.documentsNotes) {
        lc.documentsNotes = {};
      }
      lc.documentsNotes.uploadedDocuments = uploadedDocuments;
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
    // Handle Mongoose validation errors specifically
    if (error.name === "ValidationError") {
      const validationErrors = Object.values(error.errors).map((err) => ({
        field: err.path,
        message: err.message,
      }));
      
      // De-duplicate errors to handle Mongoose sub-document validation quirks
      const uniqueErrorStrings = new Set(validationErrors.map(e => JSON.stringify(e)));
      const uniqueErrors = Array.from(uniqueErrorStrings).map(e => JSON.parse(e));

      return next(new ApiError(400, "LC validation failed", uniqueErrors));
    }

    // Cleanup uploaded files on any other error
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
    // Pass other errors to the generic error handler
    next(new ApiError(500, error.message));
  }
}

async function getAllLCs(_, res, next) {
  try {
    const lcs = await LC.find()
      .populate("productInfo.quantityUnit", "name type conversionFactor")
      .populate("basicInfo.accountId")
      .populate("financialInfo.costs.accountId")
      .populate("shippingCustomsInfo.costs.accountId")
      .populate("agentTransportInfo.costs.accountId")
      .populate("otherExpenses.costs.accountId");
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
    const lc = await LC.findById(id)
      .populate("productInfo.quantityUnit", "name type conversionFactor")
      .populate("basicInfo.accountId")
      .populate("financialInfo.costs.accountId")
      .populate("shippingCustomsInfo.costs.accountId")
      .populate("agentTransportInfo.costs.accountId")
      .populate("otherExpenses.costs.accountId");
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

async function getAllCompletedLCs(_, res, next) {
  try {
    const lcs = await LC.find({ "basicInfo.status": /^Completed$/i })
      .populate("productInfo.quantityUnit", "name type conversionFactor")
      .select("_id basicInfo.lcNumber basicInfo.status productInfo");
    return res
      .status(200)
      .json(new ApiResponse(200, lcs, "All LCs fetched successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function getLCCountsByStatus(req, res, next) {
  try {
    const counts = await LC.aggregate([
      {
        $group: {
          _id: "$basicInfo.status",
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

async function exportLCAsPDF(req, res, next) {
  try {
    const { id } = req.params;
    const lc = await LC.findById(id);

    if (!lc) {
      return next(new ApiError(404, "LC not found"));
    }

    generateLCPDF(lc, res);

  } catch (error) {
    next(new ApiError(500, error.message));
  }
}
async function getActiveLcs(req,res,next){
  try {
    const lcs = await LC.find({ "basicInfo.status": /^Active$/i })
      .populate("productInfo.quantityUnit", "name type conversionFactor")
      .select("_id basicInfo.lcNumber basicInfo.status productInfo");
    return res
      .status(200)
      .json(new ApiResponse(200, lcs, "All LCs fetched successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function getLCSummary(req, res, next) {
  try {
    // Get pagination parameters from query string
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const skip = (page - 1) * limit;

    // Get total documents and the paginated documents in parallel
    const [totalDocuments, lcs] = await Promise.all([
      LC.countDocuments(),
      LC.find()
        .populate("productInfo.quantityUnit", "name")
        .sort({ createdAt: -1 }) // Sort by newest first for consistent pagination
        .skip(skip)
        .limit(limit),
    ]);

    const calculateTotalCost = (lc) => {
      let totalCost = 0;
      if (lc.financialInfo) {
        totalCost += lc.financialInfo.lcAmountBdt || 0;
        if (lc.financialInfo.costs) {
          totalCost += lc.financialInfo.costs.reduce(
            (sum, cost) => sum + (cost.amount || 0),
            0
          );
        }
      }
      if (lc.shippingCustomsInfo && lc.shippingCustomsInfo.costs) {
        totalCost += lc.shippingCustomsInfo.costs.reduce(
          (sum, cost) => sum + (cost.amount || 0),
          0
        );
      }
      if (lc.agentTransportInfo && lc.agentTransportInfo.costs) {
        totalCost += lc.agentTransportInfo.costs.reduce(
          (sum, cost) => sum + (cost.amount || 0),
          0
        );
      }
      if (lc.otherExpenses && lc.otherExpenses.costs) {
        totalCost += lc.otherExpenses.costs.reduce(
          (sum, cost) => sum + (cost.amount || 0),
          0
        );
      }
      return totalCost;
    };

    const summary = lcs.map((lc) => ({
      _id: lc._id,
      lcNumber: lc.basicInfo.lcNumber,
      lcOpeningDate: lc.basicInfo.lcOpeningDate,
      status: lc.basicInfo.status,
      supplierName: lc.basicInfo.supplierName,
      dueDate: lc.shippingCustomsInfo?.expectedArrivalDate,
      products: lc.productInfo.map((p) => ({
        itemName: p.itemName,
        quantity: p.quantity,
        unit: p.quantityUnit?.name || "N/A",
      })),
      totalCost: calculateTotalCost(lc),
    }));

    // Construct the response object with pagination info
    const responseData = {
      data: summary,
      pagination: {
        totalDocuments,
        totalPages: Math.ceil(totalDocuments / limit),
        currentPage: page,
        limit,
      },
    };

    return res
      .status(200)
      .json(
        new ApiResponse(200, responseData, "LCs summary fetched successfully")
      );
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function addExpenseToLC(req, res, next) {
  try {
    const { lcId, category, expense } = req.body;

    // 1. Validate input
    if (!lcId) {
      return next(new ApiError(400, "LC ID is required in the request body."));
    }
    if (!category || !expense) {
      return next(new ApiError(400, "Category and expense data are required."));
    }

    const validCategories = [
      "financialInfo",
      "shippingCustomsInfo",
      "agentTransportInfo",
      "otherExpenses",
    ];
    if (!validCategories.includes(category)) {
      return next(
        new ApiError(
          400,
          `Invalid category. Must be one of: ${validCategories.join(", ")}`
        )
      );
    }

    // 2. Find the LC
    const lc = await LC.findById(lcId);
    if (!lc) {
      return next(new ApiError(404, "LC not found"));
    }

    // 3. Add the expense to the correct category
    if (!lc[category]) {
      lc[category] = { costs: [] };
    } else if (!lc[category].costs) {
      lc[category].costs = [];
    }

    // Explicitly validate accountId based on payment method before saving
    if (["Bank", "Mobile Banking"].includes(expense.paymentMethod) && !expense.accountId) {
      return next(new ApiError(400, "Validation failed", [{
        field: "expense.accountId",
        message: "Account ID is required for Bank and Mobile Banking payment methods."
      }]));
    }

    // Clean up empty accountId in the new expense to prevent CastError
    if (expense && (!expense.accountId || expense.accountId === '')) {
      expense.accountId = null; // Set to null if empty string
    }

    // Validate accountId if provided and not null
    if (expense.accountId) {
      const existingAccount = await Account.findById(expense.accountId);
      if (!existingAccount) {
        return next(new ApiError(400, "Validation failed", [{
          field: "expense.accountId",
          message: `Account not found.`
        }]));
      }

      // Validate that the account type matches the payment method
      if (expense.paymentMethod !== existingAccount.accountType && (expense.paymentMethod === 'Bank' || expense.paymentMethod === 'Mobile Banking')) {
        return next(new ApiError(400, "Validation failed", [{
            field: "expense.accountId",
            message: `Payment method '${expense.paymentMethod}' requires a '${expense.paymentMethod}' account, but a '${existingAccount.accountType}' account was provided.`
        }]));
      }
    }

    lc[category].costs.push(expense);

    // 4. Save the updated LC
    await lc.save();

    // 5. Repopulate all fields to be consistent with GET responses
    await lc.populate([
      {
        path: "productInfo.quantityUnit",
        select: "name type conversionFactor",
      },
      { path: "basicInfo.accountId" },
      { path: "financialInfo.costs.accountId" },
      { path: "shippingCustomsInfo.costs.accountId" },
      { path: "agentTransportInfo.costs.accountId" },
      { path: "otherExpenses.costs.accountId" },
    ]);

    return res
      .status(200)
      .json(new ApiResponse(200, lc, "Expense added successfully"));
  } catch (error) {
    if (error.name === "ValidationError") {
      const validationErrors = Object.values(error.errors).map((err) => ({
        field: err.path,
        message: err.message,
      }));

      // De-duplicate errors to handle Mongoose sub-document validation quirks
      const uniqueErrorStrings = new Set(validationErrors.map(e => JSON.stringify(e)));
      const uniqueErrors = Array.from(uniqueErrorStrings).map(e => JSON.parse(e));

      return next(
        new ApiError(400, "Expense validation failed", uniqueErrors)
      );
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
  getAllCompletedLCs,
  upload,
  getLCCountsByStatus,
  getTotalLCCount,
  downloadDocument,
  exportLCAsPDF,
  getLCSummary,
  getActiveLcs,
  addExpenseToLC,
};
