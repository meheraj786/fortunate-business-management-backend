const crypto = require("crypto");
const fs = require("fs").promises;
const path = require("path");
const multer = require("multer");
const { generateLCPDF } = require("../utils/LC_pdfGenerator");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const LC = require("../models/lc.model");
const Unit = require("../models/unit.model"); // Import Unit model
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
      return next(new ApiError(400, "LC validation failed", validationErrors));
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

async function addExpenseToLC(req, res, next) {
  try {
    const { lcId } = req.params;
    const { name, amount, date, paymentMethod, accountId } = req.body;

    const validationErrors = [];
    if (!name) {
      validationErrors.push({ field: "name", message: "Name is required" });
    }
    if (!amount) {
      validationErrors.push({ field: "amount", message: "Amount is required" });
    }
    if (!paymentMethod) {
      validationErrors.push({
        field: "paymentMethod",
        message: "Payment method is required",
      });
    }
    if (
      (paymentMethod === "Bank" || paymentMethod === "Mobile Banking") &&
      !accountId
    ) {
      validationErrors.push({
        field: "accountId",
        message: "Account ID is required for this payment method",
      });
    }

    if (validationErrors.length > 0) {
      return next(new ApiError(400, "Validation failed", validationErrors));
    }

    const lc = await LC.findById(lcId);
    if (!lc) {
      throw new ApiError(404, "LC not found");
    }

    const newExpense = {
      name,
      amount,
      date: date || new Date(),
      paymentMethod,
      accountId: accountId || null,
    };

    if (!lc.otherExpenses) {
      lc.otherExpenses = { costs: [] };
    }
    if (!lc.otherExpenses.costs) {
      lc.otherExpenses.costs = [];
    }
    lc.otherExpenses.costs.push(newExpense);

    await lc.save();

    return res
      .status(200)
      .json(new ApiResponse(200, lc, "Expense added successfully"));
  } catch (error) {
    if (error.name === "ValidationError") {
      const validationErrors = Object.values(error.errors).map((err) => ({
        field: err.path,
        message: err.message,
      }));
      return next(new ApiError(400, "LC validation failed", validationErrors));
    }
    next(error);
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
  exportLCAsPDF,
  getLCSummary,
  getActiveLcs
};

async function getLCSummary(req, res, next) {
  try {
    const lcs = await LC.find().populate("productInfo.quantityUnit", "name");

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

    return res
      .status(200)
      .json(new ApiResponse(200, summary, "LCs summary fetched successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}
