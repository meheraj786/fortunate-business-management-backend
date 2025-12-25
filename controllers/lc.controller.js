const crypto = require("crypto");
const fs = require("fs").promises;
const path = require("path");
const multer = require("multer");
const { generateLCPDF } = require("../utils/LC_pdfGenerator");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const LC = require("../models/lc.model");
const Unit = require("../models/unit.model");
const Account = require("../models/account.model");
const DailyCash = require("../models/dailyCash.model");
const Transaction = require("../models/transaction.model");
const Trash = require("../models/trash.model"); // Added Trash Model
require("../models/account.model");
const mongoose = require("mongoose");

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

/* ================= CREATE LC ================= */
async function createLC(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    let lcData;
    if (req.body.lcData) {
      lcData = JSON.parse(req.body.lcData);
    } else if (req.body.lc_data) {
      lcData = JSON.parse(req.body.lc_data);
    } else {
      lcData = req.body;
    }

    const sectionsWithCosts = [
      "financialInfo",
      "shippingCustomsInfo",
      "agentTransportInfo",
      "otherExpenses",
    ];
    for (const section of sectionsWithCosts) {
      if (lcData[section] && lcData[section].costs) {
        for (const cost of lcData[section].costs) {
          if (!cost.accountId) {
            cost.accountId = null;
          }

          if (
            ["Bank", "Mobile Banking", "Cash"].includes(cost.paymentMethod) &&
            !cost.accountId
          ) {
            throw new ApiError(400, `Account ID is required for ${cost.paymentMethod} in "${cost.name}".`);
          }

          if (cost.accountId) {
            const existingAccount = await Account.findById(cost.accountId).session(session);
            if (!existingAccount) {
              throw new ApiError(400, `Account not found for cost "${cost.name}".`);
            }
            if (existingAccount.accountType !== cost.paymentMethod) {
              throw new ApiError(400, `Payment method mismatch for cost "${cost.name}".`);
            }
          }
        }
      }
    }

    if (lcData.productInfo && Array.isArray(lcData.productInfo)) {
      for (const product of lcData.productInfo) {
        if (product.quantityUnit) {
          if (typeof product.quantityUnit === "object" && product.quantityUnit.id) {
            product.quantityUnit = product.quantityUnit.id;
          }
          const existingUnit = await Unit.findById(product.quantityUnit).session(session);
          if (!existingUnit) {
            throw new ApiError(400, `Unit not found for product ${product.itemName}`);
          }
        }
      }
    }

    const lc = new LC(lcData);

    if (req.files && req.files.length > 0) {
      const uploadedDocuments = [];
      for (const file of req.files) {
        const fileBuffer = await fs.readFile(file.path);
        const hash = crypto.createHash("sha256").update(fileBuffer).digest("hex");
        const storedName = `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.-]/g, "_")}`;

        uploadedDocuments.push({
          originalName: file.originalname,
          storedName: storedName,
          mimeType: file.mimetype,
          sizeBytes: file.size,
          hashSha256: hash,
        });
      }
      lc.documentsNotes = { uploadedDocuments };
    }

    await lc.save({ session });

    if (req.files && req.files.length > 0) {
      const newLcDir = path.join(uploadDir, lc._id.toString());
      await ensureDir(newLcDir);
      for (const file of req.files) {
        await fs.rename(file.path, path.join(newLcDir, file.filename));
      }
    }

    for (const section of sectionsWithCosts) {
      if (lcData[section] && lcData[section].costs) {
        for (const cost of lcData[section].costs) {
          if (cost.accountId && cost.amount > 0) {
            const costDateNormalized = new Date(cost.date);
            costDateNormalized.setHours(0, 0, 0, 0);
            const dailyCash = await DailyCash.findOne({ date: costDateNormalized }).session(session);

            if (!dailyCash || dailyCash.status === "Closed") {
              throw new ApiError(400, `Daily cash is closed for ${costDateNormalized.toDateString()}.`);
            }

            const account = await Account.findById(cost.accountId).session(session);
            if (!account || account.balance < cost.amount) {
              throw new ApiError(400, `Insufficient balance or account not found for ${cost.name}.`);
            }

            account.balance -= cost.amount;
            await account.save({ session });

            await Transaction.create([{
              accountId: cost.accountId,
              date: cost.date,
              description: `LC Cost: ${cost.name} for LC: ${lc.basicInfo.lcNumber}`,
              transactionType: "Expense",
              amount: cost.amount,
              name: `LC Cost: ${cost.name}`,
              source: "Auto",
              category: "LC",
              paymentMethod: cost.paymentMethod,
              reference: lc._id,
              referenceModel: "LC",
            }], { session });
          }
        }
      }
    }

    await session.commitTransaction();
    session.endSession();
    res.status(201).json(new ApiResponse(201, lc, "LC created successfully"));
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    if (req.files) {
      for (const file of req.files) try { await fs.unlink(file.path); } catch (e) {}
    }
    next(error);
  }
}

/* ================= HELPER TRANSACTION HANDLER ================= */
async function _handleLCCostTransaction(cost, lc, session) {
  if (!cost.accountId || !cost.amount || cost.amount <= 0) return;

  const costDateNormalized = new Date(cost.date || new Date());
  costDateNormalized.setHours(0, 0, 0, 0);

  const openSession = await DailyCash.findOne({ date: costDateNormalized, status: "Open" }).session(session);
  if (!openSession) {
    throw new ApiError(400, `Daily cash is closed for ${costDateNormalized.toDateString()}.`);
  }

  const account = await Account.findById(cost.accountId).session(session);
  if (!account || account.balance < cost.amount) {
    throw new ApiError(400, `Insufficient balance for cost '${cost.name}'.`);
  }

  account.balance -= cost.amount;
  await account.save({ session });

  await Transaction.create([{
    accountId: cost.accountId,
    date: cost.date || new Date(),
    description: `LC Cost: ${cost.name} for LC: ${lc.basicInfo.lcNumber}`,
    transactionType: "Expense",
    amount: cost.amount,
    name: `LC Cost: ${cost.name}`,
    source: "Auto",
    category: "LC",
    paymentMethod: cost.paymentMethod,
    reference: lc._id,
    referenceModel: "LC",
  }], { session });
}

/* ================= GET ALL (Filtered) ================= */
async function getAllLCs(_, res, next) {
  try {
    const lcs = await LC.find({ isDeleted: { $ne: true } })
      .populate("productInfo.quantityUnit", "name type conversionFactor")
      .populate("basicInfo.accountId")
      .populate("financialInfo.costs.accountId")
      .populate("shippingCustomsInfo.costs.accountId")
      .populate("agentTransportInfo.costs.accountId")
      .populate("otherExpenses.costs.accountId");
    res.status(200).json(new ApiResponse(200, lcs, "All LCs fetched successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

/* ================= GET BY ID (Filtered) ================= */
async function getLCById(req, res, next) {
  try {
    const { id } = req.params;
    const lc = await LC.findOne({ _id: id, isDeleted: { $ne: true } })
      .populate("productInfo.quantityUnit", "name type conversionFactor")
      .populate("basicInfo.accountId")
      .populate("financialInfo.costs.accountId")
      .populate("shippingCustomsInfo.costs.accountId")
      .populate("agentTransportInfo.costs.accountId")
      .populate("otherExpenses.costs.accountId");

    if (!lc) return next(new ApiError(404, "LC not found"));
    res.status(200).json(new ApiResponse(200, lc, "LC fetched successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

/* ================= UPDATE (Filtered) ================= */
async function updateLC(req, res, next) {
  try {
    const { id } = req.params;
    const lc = await LC.findOne({ _id: id, isDeleted: { $ne: true } });

    if (!lc) return next(new ApiError(404, "LC not found"));

    Object.assign(lc, req.body);
    const updated = await lc.save();
    res.status(200).json(new ApiResponse(200, updated, "LC updated successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

/* ================= SOFT DELETE & TRASH ================= */
async function deleteLC(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const deletedBy = req.cookies?.userId || req.user?._id || null;

    // Soft delete the LC
    const deletedLC = await LC.findOneAndUpdate(
      { _id: id, isDeleted: { $ne: true } },
      { isDeleted: true },
      { new: true, session }
    );

    if (!deletedLC) throw new ApiError(404, "LC not found");

    // Move to Trash
    await Trash.create([{
      docId: deletedLC._id,
      model: "LC",
      deletedBy,
    }], { session });

    // Financial Reversal Logic
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dailyCash = await DailyCash.findOne({ date: today, status: "Open" }).session(session);

    if (!dailyCash) {
      throw new ApiError(400, `Daily cash is closed for ${today.toDateString()}. Cannot reverse costs.`);
    }

    const sectionsWithCosts = [
      deletedLC.financialInfo,
      deletedLC.shippingCustomsInfo,
      deletedLC.agentTransportInfo,
      deletedLC.otherExpenses,
    ];

    for (const section of sectionsWithCosts) {
      if (section?.costs) {
        for (const cost of section.costs) {
          if (cost.accountId && cost.amount > 0) {
            const account = await Account.findById(cost.accountId).session(session);
            if (account) {
              account.balance += cost.amount;
              await account.save({ session });

              await Transaction.create([{
                accountId: cost.accountId,
                date: new Date(),
                description: `Reversal: LC Cost ${cost.name} for LC ${deletedLC.basicInfo.lcNumber}`,
                transactionType: "Income",
                amount: cost.amount,
                name: `LC Cost Reversal: ${cost.name}`,
                source: "Auto",
                category: "LC Reversal",
                paymentMethod: cost.paymentMethod,
                reference: deletedLC._id,
                referenceModel: "LC",
              }], { session });
            }
          }
        }
      }
    }

    await session.commitTransaction();
    session.endSession();
    res.status(200).json(new ApiResponse(200, deletedLC, "LC moved to trash successfully"));
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    next(error);
  }
}

/* ================= COMPLETED LCS ================= */
async function getAllCompletedLCs(_, res, next) {
  try {
    const lcs = await LC.find({ 
      "basicInfo.status": /^Completed$/i, 
      isDeleted: { $ne: true } 
    })
      .populate("productInfo.quantityUnit", "name type conversionFactor")
      .select("_id basicInfo.lcNumber basicInfo.status productInfo");
    res.status(200).json(new ApiResponse(200, lcs, "Completed LCs fetched successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

/* ================= COUNTS BY STATUS ================= */
async function getLCCountsByStatus(req, res, next) {
  try {
    const counts = await LC.aggregate([
      { $match: { isDeleted: { $ne: true } } },
      { $group: { _id: "$basicInfo.status", count: { $sum: 1 } } },
    ]);

    const statusCounts = { Active: 0, Completed: 0, Draft: 0, Cancelled: 0 };
    counts.forEach((item) => { statusCounts[item._id] = item.count; });

    res.status(200).json(new ApiResponse(200, statusCounts, "LC counts fetched"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

/* ================= TOTAL COUNT ================= */
async function getTotalLCCount(req, res, next) {
  try {
    const totalCount = await LC.countDocuments({ isDeleted: { $ne: true } });
    res.status(200).json(new ApiResponse(200, { total: totalCount }, "Total LC count fetched"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

/* ================= DOWNLOAD DOC ================= */
async function downloadDocument(req, res, next) {
  try {
    const { lcId, filename } = req.params;
    const filePath = path.join(uploadDir, lcId, filename);

    await fs.access(filePath, fs.constants.F_OK);
    res.download(filePath);
  } catch (error) {
    next(new ApiError(404, "File not found"));
  }
}

/* ================= EXPORT PDF ================= */
async function exportLCAsPDF(req, res, next) {
  try {
    const { id } = req.params;
    const lc = await LC.findOne({ _id: id, isDeleted: { $ne: true } })
      .populate("productInfo.quantityUnit", "name type conversionFactor")
      .populate("basicInfo.accountId")
      .populate("financialInfo.costs.accountId")
      .populate("shippingCustomsInfo.costs.accountId")
      .populate("agentTransportInfo.costs.accountId")
      .populate("otherExpenses.costs.accountId");

    if (!lc) return next(new ApiError(404, "LC not found"));
    generateLCPDF(lc, res);
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

/* ================= ACTIVE LCS ================= */
async function getActiveLcs(req, res, next) {
  try {
    const lcs = await LC.find({ 
      "basicInfo.status": /^Active$/i, 
      isDeleted: { $ne: true } 
    })
      .populate("productInfo.quantityUnit", "name type conversionFactor")
      .select("_id basicInfo.lcNumber basicInfo.status productInfo");
    res.status(200).json(new ApiResponse(200, lcs, "Active LCs fetched"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

/* ================= SUMMARY ================= */
async function getLCSummary(req, res, next) {
  try {
    const { status, sortBy, sortOrder } = req.query;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const skip = (page - 1) * limit;

    const filter = { isDeleted: { $ne: true } };
    if (status) filter["basicInfo.status"] = status;

    const sort = {};
    const order = sortOrder === "desc" ? -1 : 1;
    if (sortBy === "openingDate") sort["basicInfo.lcOpeningDate"] = order;
    else if (sortBy === "dueDate") sort["shippingCustomsInfo.expectedArrivalDate"] = order;
    else if (sortBy === "totalCost") sort["totalCost"] = order;
    else sort["createdAt"] = -1;

    const [totalDocuments, lcs] = await Promise.all([
      LC.countDocuments(filter),
      LC.find(filter).populate("productInfo.quantityUnit", "name").sort(sort).skip(skip).limit(limit),
    ]);

    const data = lcs.map((lc) => ({
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
      totalCost: lc.totalCost,
    }));

    res.status(200).json(new ApiResponse(200, {
      data,
      pagination: { totalDocuments, totalPages: Math.ceil(totalDocuments / limit), currentPage: page, limit }
    }, "Summary fetched"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

/* ================= ADD EXPENSE ================= */
async function addExpenseToLC(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { lcId, category, expense } = req.body;
    const lc = await LC.findOne({ _id: lcId, isDeleted: { $ne: true } }).session(session);
    if (!lc) throw new ApiError(404, "LC not found");

    if (expense && (!expense.accountId || expense.accountId === '')) {
      expense.accountId = null;
    }

    if (!lc[category]) lc[category] = { costs: [] };
    lc[category].costs.push(expense);

    await _handleLCCostTransaction(expense, lc, session);
    await lc.save({ session });

    await session.commitTransaction();
    session.endSession();

    await lc.populate([
      { path: "productInfo.quantityUnit" },
      { path: "basicInfo.accountId" },
      { path: "financialInfo.costs.accountId" },
      { path: "shippingCustomsInfo.costs.accountId" },
      { path: "agentTransportInfo.costs.accountId" },
      { path: "otherExpenses.costs.accountId" },
    ]);

    res.status(200).json(new ApiResponse(200, lc, "Expense added successfully"));
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    next(error);
  }
}

/* ================= SEARCH SUMMARY ================= */
async function searchLCSummary(req, res, next) {
  try {
    const { searchQuery, status, sortBy, sortOrder } = req.query;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const skip = (page - 1) * limit;

    const filter = { isDeleted: { $ne: true } };
    if (status) filter["basicInfo.status"] = status;
    if (searchQuery) {
      const regex = new RegExp(searchQuery, "i");
      filter["$or"] = [
        { "basicInfo.lcNumber": regex },
        { "basicInfo.supplierName": regex },
        { "productInfo.itemName": regex },
      ];
    }

    const sort = {};
    const order = sortOrder === "desc" ? -1 : 1;
    if (sortBy === "openingDate") sort["basicInfo.lcOpeningDate"] = order;
    else sort["createdAt"] = -1;

    const [totalDocuments, lcs] = await Promise.all([
      LC.countDocuments(filter),
      LC.find(filter).populate("productInfo.quantityUnit", "name").sort(sort).skip(skip).limit(limit),
    ]);

    const data = lcs.map((lc) => ({
      _id: lc._id,
      lcNumber: lc.basicInfo.lcNumber,
      lcOpeningDate: lc.basicInfo.lcOpeningDate,
      status: lc.basicInfo.status,
      supplierName: lc.basicInfo.supplierName,
      totalCost: lc.totalCost,
    }));

    res.status(200).json(new ApiResponse(200, {
      data,
      pagination: { totalDocuments, totalPages: Math.ceil(totalDocuments / limit), currentPage: page }
    }, "Search results fetched"));
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
  getAllCompletedLCs,
  upload,
  getLCCountsByStatus,
  getTotalLCCount,
  downloadDocument,
  exportLCAsPDF,
  getLCSummary,
  getActiveLcs,
  addExpenseToLC,
  searchLCSummary,
};