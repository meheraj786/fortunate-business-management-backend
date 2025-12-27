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
const Trash = require("../models/trash.model");
require("../models/account.model");
const mongoose = require("mongoose");

// ডিরেক্টরি পাথ সেটআপ
const uploadDir = path.resolve(__dirname, "../uploads");
const tempDir = path.join(uploadDir, "temp");

async function ensureDir(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}

ensureDir(uploadDir);
ensureDir(tempDir);

// Multer কনফিগারেশন - ফাইল নেম ডিস্ক এবং ডাটাবেজ সিঙ্ক করার জন্য
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, tempDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, "_");
    cb(null, uniqueSuffix + "-" + sanitizedName);
  },
});

const upload = multer({ storage: storage });

/* ================= HELPER: TRANSACTION HANDLER ================= */
async function _handleLCCostTransaction(cost, lc, session) {
  if (!cost.accountId || !cost.amount || cost.amount <= 0) return;

  const costDate = new Date(cost.date || new Date());
  costDate.setHours(0, 0, 0, 0);

  const dailyCash = await DailyCash.findOne({ date: costDate, status: "Open" }).session(session);
  if (!dailyCash) throw new ApiError(400, `Daily cash is closed for ${costDate.toDateString()}.`);

  const account = await Account.findById(cost.accountId).session(session);
  if (!account || account.balance < cost.amount) throw new ApiError(400, `Insufficient balance in ${account?.accountName || 'account'}.`);

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

/* ================= CREATE LC ================= */
async function createLC(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    let lcData = req.body.lcData ? JSON.parse(req.body.lcData) : (req.body.lc_data ? JSON.parse(req.body.lc_data) : req.body);
    const sectionsWithCosts = ["financialInfo", "shippingCustomsInfo", "agentTransportInfo", "otherExpenses"];
    const lc = new LC(lcData);

    if (req.files && req.files.length > 0) {
      const uploadedDocuments = [];
      for (const file of req.files) {
        const fileBuffer = await fs.readFile(file.path);
        const hash = crypto.createHash("sha256").update(fileBuffer).digest("hex");
        uploadedDocuments.push({
          originalName: file.originalname,
          storedName: file.filename, // Multer এর জেনারেট করা সঠিক নাম
          mimeType: file.mimetype,
          sizeBytes: file.size,
          hashSha256: hash,
        });
      }
      lc.documentsNotes = { uploadedDocuments, note: lcData.documentsNotes?.note || "No notes given" };
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
      if (lcData[section]?.costs) {
        for (const cost of lcData[section].costs) {
          if (cost.accountId && cost.amount > 0) {
            await _handleLCCostTransaction(cost, lc, session);
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

/* ================= UPDATE LC (Filtered) ================= */
async function updateLC(req, res, next) {
  try {
    const { id } = req.params;
    const updated = await LC.findOneAndUpdate(
      { _id: id, isDeleted: { $ne: true } },
      req.body,
      { new: true, runValidators: true }
    );
    if (!updated) return next(new ApiError(404, "LC not found"));
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

    const deletedLC = await LC.findOneAndUpdate(
      { _id: id, isDeleted: { $ne: true } },
      { isDeleted: true },
      { new: true, session }
    );

    if (!deletedLC) throw new ApiError(404, "LC not found");

    await Trash.create([{ docId: deletedLC._id, model: "LC", deletedBy }], { session });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dailyCash = await DailyCash.findOne({ date: today, status: "Open" }).session(session);

    if (dailyCash) {
      const sections = ["financialInfo", "shippingCustomsInfo", "agentTransportInfo", "otherExpenses"];
      for (const sec of sections) {
        if (deletedLC[sec]?.costs) {
          for (const cost of deletedLC[sec].costs) {
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
                  reference: deletedLC._id,
                  referenceModel: "LC",
                }], { session });
              }
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

/* ================= DOWNLOAD DOC (Filename Sync) ================= */
async function downloadDocument(req, res, next) {
  try {
    const { lcId, filename } = req.params;
    const filePath = path.join(uploadDir, lcId, filename);

    await fs.access(filePath, fs.constants.F_OK);

    const lc = await LC.findById(lcId);
    const docInfo = lc?.documentsNotes?.uploadedDocuments?.find(d => d.storedName === filename);
    const downloadName = docInfo ? docInfo.originalName : filename;

    res.download(filePath, downloadName);
  } catch (error) {
    return next(new ApiError(404, "File not found or mismatch in filename"));
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

/* ================= COUNTS BY STATUS (Fixed Definition) ================= */
async function getLCCountsByStatus(req, res, next) {
  try {
    const counts = await LC.aggregate([
      { $match: { isDeleted: { $ne: true } } },
      { $group: { _id: "$basicInfo.status", count: { $sum: 1 } } },
    ]);

    const statusCounts = { Active: 0, Completed: 0, Draft: 0, Cancelled: 0 };
    counts.forEach(item => {
      if (statusCounts.hasOwnProperty(item._id)) statusCounts[item._id] = item.count;
    });

    res.status(200).json(new ApiResponse(200, statusCounts, "LC counts fetched"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

/* ================= SUMMARY & SEARCH ================= */
async function getLCSummary(req, res, next) {
  try {
    const { status, sortBy, sortOrder, page = 1, limit = 10 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const filter = { isDeleted: { $ne: true } };
    if (status) filter["basicInfo.status"] = status;

    const sort = {};
    const order = sortOrder === "desc" ? -1 : 1;
    if (sortBy === "openingDate") sort["basicInfo.lcOpeningDate"] = order;
    else if (sortBy === "totalCost") sort["totalCost"] = order;
    else sort["createdAt"] = -1;

    const [totalDocuments, lcs] = await Promise.all([
      LC.countDocuments(filter),
      LC.find(filter).populate("productInfo.quantityUnit", "name").sort(sort).skip(skip).limit(parseInt(limit)),
    ]);

    const data = lcs.map(lc => ({
      _id: lc._id,
      lcNumber: lc.basicInfo.lcNumber,
      lcOpeningDate: lc.basicInfo.lcOpeningDate,
      status: lc.basicInfo.status,
      supplierName: lc.basicInfo.supplierName,
      products: lc.productInfo.map(p => ({ itemName: p.itemName, quantity: p.quantity, unit: p.quantityUnit?.name })),
      totalCost: lc.totalCost,
    }));

    res.status(200).json(new ApiResponse(200, {
      data,
      pagination: { totalDocuments, totalPages: Math.ceil(totalDocuments / limit), currentPage: parseInt(page) }
    }, "Summary fetched"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function searchLCSummary(req, res, next) {
  try {
    const { searchQuery, status } = req.query;
    const filter = { isDeleted: { $ne: true } };
    if (status) filter["basicInfo.status"] = status;
    if (searchQuery) {
      const regex = new RegExp(searchQuery, "i");
      filter["$or"] = [{ "basicInfo.lcNumber": regex }, { "basicInfo.supplierName": regex }, { "productInfo.itemName": regex }];
    }
    const lcs = await LC.find(filter).limit(20);
    res.status(200).json(new ApiResponse(200, lcs, "Search results fetched"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

/* ================= OTHER UTILS ================= */
async function getTotalLCCount(req, res, next) {
  try {
    const total = await LC.countDocuments({ isDeleted: { $ne: true } });
    res.status(200).json(new ApiResponse(200, { total }, "Total LC count fetched"));
  } catch (error) { next(new ApiError(500, error.message)); }
}

async function getActiveLcs(req, res, next) {
  try {
    const lcs = await LC.find({ "basicInfo.status": /^Active$/i, isDeleted: { $ne: true } })
      .select("_id basicInfo.lcNumber basicInfo.status productInfo");
    res.status(200).json(new ApiResponse(200, lcs, "Active LCs fetched"));
  } catch (error) { next(new ApiError(500, error.message)); }
}

async function addExpenseToLC(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { lcId, category, expense } = req.body;
    const lc = await LC.findOne({ _id: lcId, isDeleted: { $ne: true } }).session(session);
    if (!lc) throw new ApiError(404, "LC not found");
    if (!lc[category]) lc[category] = { costs: [] };
    lc[category].costs.push(expense);
    await _handleLCCostTransaction(expense, lc, session);
    await lc.save({ session });
    await session.commitTransaction();
    session.endSession();
    res.status(200).json(new ApiResponse(200, lc, "Expense added successfully"));
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    next(error);
  }
}

async function getAllCompletedLCs(_, res, next) {
  try {
    const lcs = await LC.find({ "basicInfo.status": /^Completed$/i, isDeleted: { $ne: true } })
      .select("_id basicInfo.lcNumber basicInfo.status productInfo");
    res.status(200).json(new ApiResponse(200, lcs, "Completed LCs fetched"));
  } catch (error) { next(new ApiError(500, error.message)); }
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