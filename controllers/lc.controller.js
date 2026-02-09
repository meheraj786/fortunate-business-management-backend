const path = require("path");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const mongoose = require("mongoose");

// Local Utilities and Services
const { startOfDay, endOfDay, now } = require("../utils/timezone.util");
const storageUtil = require("../utils/storage.util.js");
const { generateLCPDF } = require("../utils/LC_pdfGenerator");
const { ApiError } = require("../utils/ApiError");
const logger = require("../utils/logger");
const { ApiResponse } = require("../utils/ApiResponse");
const { formatAccountLabel } = require("../utils/format.util");

// Models
const LC = require("../models/lc.model");
const Unit = require("../models/unit.model");
const Account = require("../models/account.model");
const DailyCash = require("../models/dailyCash.model");
const Transaction = require("../models/transaction.model");
const Product = require("../models/product.model");
const Trash = require("../models/trash.model");
require("../models/account.model"); // Ensure Account model is registered for population

// --- Initialize Storage ---
// Ensure all necessary directories exist on application startup.
storageUtil.initializeStorage();

// --- Multer Configuration ---
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    // Always upload to the temporary directory first.
    cb(null, storageUtil.TEMP_DIR);
  },
  filename: function (req, file, cb) {
    // Use a temporary unique name. The final name will be set by our storage utility.
    const uniqueSuffix = uuidv4();
    const extension = path.extname(file.originalname);
    cb(null, `${uniqueSuffix}${extension}`);
  },
});

const upload = multer({ storage: storage });

async function createLC(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  const uploadedFiles = req.files || [];

  try {
    let lcData;
    if (req.body.lcData) {
      lcData = JSON.parse(req.body.lcData);
    } else if (req.body.lc_data) {
      lcData = JSON.parse(req.body.lc_data);
    } else {
      lcData = req.body;
    }

    // --- Validation ---
    const sectionsWithCosts = [
      "financialInfo",
      "shippingCustomsInfo",
      "agentTransportInfo",
      "otherExpenses",
      "documentProductInfo",
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
            throw new ApiError(
              400,
              `Account ID is required for ${cost.paymentMethod} payment method in cost "${cost.name}".`,
            );
          }
          if (cost.accountId) {
            const existingAccount = await Account.findById(
              cost.accountId,
            ).session(session);
            if (!existingAccount) {
              throw new ApiError(
                400,
                `Account with ID ${cost.accountId} not found for cost "${cost.name}".`,
              );
            }
            if (existingAccount.accountType !== cost.paymentMethod) {
              throw new ApiError(
                400,
                `Payment method '${cost.paymentMethod}' requires a '${cost.paymentMethod}' account, but a '${existingAccount.accountType}' account was provided for cost "${cost.name}".`,
              );
            }
          }
        }
      }
    }
    if (lcData.productInfo && Array.isArray(lcData.productInfo)) {
      for (const product of lcData.productInfo) {
        if (product.quantityUnit) {
          if (
            typeof product.quantityUnit === "object" &&
            product.quantityUnit.id
          ) {
            product.quantityUnit = product.quantityUnit.id;
          }
          const existingUnit = await Unit.findById(
            product.quantityUnit,
          ).session(session);
          if (!existingUnit) {
            throw new ApiError(
              400,
              `Unit with ID ${product.quantityUnit} not found for product ${product.itemName}`,
            );
          }
        }
      }
    }
    // --- End Validation ---

    // 1. Prepare document metadata without moving files
    const preparedDocs = uploadedFiles.map((file) =>
      storageUtil.prepareDocumentData(file),
    );

    // 2. Prepare the final LC data for the database
    const newLcId = new mongoose.Types.ObjectId();
    if (!lcData.documentsNotes) {
      lcData.documentsNotes = {};
    }
    lcData.documentsNotes.uploadedDocuments = preparedDocs.map(
      (p) => p.docData,
    );
    lcData._id = newLcId;
    lcData.createdBy = req.user?._id || null;

    // 3. Create and save the LC document
    const lc = new LC(lcData);
    await lc.save({ session });

    // 4. Handle post-save operations like transactions
    for (const section of sectionsWithCosts) {
      if (lcData[section] && lcData[section].costs) {
        for (const cost of lcData[section].costs) {
          await _handleLCCostTransaction(
            cost,
            lc,
            session,
            req.businessTimezone,
          );
        }
      }
    }

    // 5. If DB operations are successful, commit files to permanent storage
    for (const preparedDoc of preparedDocs) {
      await storageUtil.commitDocument(
        preparedDoc.tempPath,
        preparedDoc.docData,
        lc.basicInfo.lcNumber,
      );
    }

    // 6. Commit the database transaction
    await session.commitTransaction();
    session.endSession();

    return res
      .status(201)
      .json(new ApiResponse(201, lc, "LC created successfully"));
  } catch (error) {
    await session.abortTransaction();
    session.endSession();

    // On error, only cleanup files from the temp directory
    await storageUtil.cleanupTempFiles(uploadedFiles);

    if (error instanceof ApiError) {
      return next(error);
    }
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `An LC with the same ${field} '${value}' already exists.`,
        ),
      );
    }
    if (error.name === "ValidationError") {
      const firstErrorField = Object.keys(error.errors)[0];
      const userFriendlyMessage = `Validation failed: ${error.errors[firstErrorField].message}`;
      return next(new ApiError(400, userFriendlyMessage, error.errors));
    }

    next(
      new ApiError(500, error.message || "Something went wrong creating LC."),
    );
  }
}

/**
 * @param {object} cost The cost object from the LC
 * @param {mongoose.Model} lc The LC document
 * @param {mongoose.ClientSession} session The mongoose session for the transaction
 * @param {string} timezone The business timezone
 */
async function _handleLCCostTransaction(cost, lc, session, timezone) {
  // Only process costs that have an account and a valid amount
  if (!cost.accountId || !cost.amount || cost.amount <= 0) {
    return;
  }

  // 1. DailyCash Gatekeeper Check
  const costDate = cost.date || now();
  const costDateNormalized = startOfDay(new Date(costDate), timezone);

  const openSession = await DailyCash.findOne({
    date: costDateNormalized,
    status: "Open",
    isDeleted: false,
  }).session(session);
  if (!openSession) {
    throw new ApiError(
      400,
      `Daily cash is closed for ${costDateNormalized.toDateString()}. Cannot record LC cost.`,
    );
  }

  // 2. Find account and update balance
  const account = await Account.findById(cost.accountId).session(session);
  if (!account) {
    throw new ApiError(
      404,
      `Account with ID ${cost.accountId} not found for cost '${cost.name}'.`,
    );
  }
  if (account.balance < cost.amount) {
    throw new ApiError(
      400,
      `Insufficient balance in account '${account.accountName}' for cost '${cost.name}'.`,
    );
  }

  account.balance -= cost.amount;
  await account.save({ session });

  // 3. Create Transaction for the LC cost
  await Transaction.create(
    [
      {
        accountId: cost.accountId,
        date: costDate,
        description: `LC Cost: ${cost.name} for LC Number: ${lc.basicInfo.lcNumber} via ${cost.paymentMethod} Account: ${formatAccountLabel(account)}.`,
        transactionType: "Expense",
        amount: cost.amount,
        name: `LC Cost: ${cost.name}`,
        source: "Auto",
        category: "LC",
        paymentMethod: cost.paymentMethod,
        reference: lc._id,
        referenceModel: "LC",
        miscReference: {
          lcNumber: lc.basicInfo.lcNumber,
          costName: cost.name,
          costAmount: cost.amount,
          paymentMethod: cost.paymentMethod,
          accountId: cost.accountId,
        },
      },
    ],
    { session },
  );
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
      .populate("agentTransportInfo.costs.accountId")
      .populate("otherExpenses.costs.accountId")
      .populate("documentProductInfo.costs.accountId")
      .populate("documentProductInfo.products.quantityUnit", "name type conversionFactor")
      .populate("createdBy", "name email")
      .populate("modifiedBy", "name email")
      .populate("deletedBy", "name email")
      .lean();
    if (!lc || lc.isDeleted) return next(new ApiError(404, "LC not found"));
    return res
      .status(200)
      .json(new ApiResponse(200, lc, "LC fetched successfully"));
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
          `A document with the same ${field} '${value}' already exists.`,
        ),
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
    next(new ApiError(500, error.message || "Something went wrong"));
  }
}

async function updateLC(req, res, next) {
  const { id } = req.params;
  const session = await mongoose.startSession();
  session.startTransaction();
  const uploadedFiles = req.files || [];
  let preparedNewDocs = [];

  try {
    let updateData;
    if (req.body.lcData) {
      updateData = JSON.parse(req.body.lcData);
    } else if (req.body.lc_data) {
      updateData = JSON.parse(req.body.lc_data);
    } else {
      updateData = req.body;
    }

    // --- Validation ---
    const sectionsWithCosts = [
      "financialInfo",
      "shippingCustomsInfo",
      "agentTransportInfo",
      "otherExpenses",
      "documentProductInfo",
    ];
    for (const section of sectionsWithCosts) {
      if (updateData[section] && updateData[section].costs) {
        for (const cost of updateData[section].costs) {
          if (cost.accountId === "") {
            cost.accountId = null;
          }
          if (
            ["Bank", "Mobile Banking", "Cash"].includes(cost.paymentMethod) &&
            !cost.accountId
          ) {
            throw new ApiError(
              400,
              `Account ID is required for ${cost.paymentMethod} payment method in cost "${cost.name}".`,
            );
          }
          if (cost.accountId) {
            const existingAccount = await Account.findById(
              cost.accountId,
            ).session(session);
            if (!existingAccount) {
              throw new ApiError(
                400,
                `Account with ID ${cost.accountId} not found for cost "${cost.name}".`,
              );
            }
            if (existingAccount.accountType !== cost.paymentMethod) {
              throw new ApiError(
                400,
                `Payment method '${cost.paymentMethod}' requires a '${cost.paymentMethod}' account, but a '${existingAccount.accountType}' account was provided.`,
              );
            }
          }
        }
      }
    }
    if (updateData.productInfo && Array.isArray(updateData.productInfo)) {
      for (const product of updateData.productInfo) {
        if (product.quantityUnit) {
          if (
            typeof product.quantityUnit === "object" &&
            product.quantityUnit.id
          ) {
            product.quantityUnit = product.quantityUnit.id;
          }
          const existingUnit = await Unit.findById(
            product.quantityUnit,
          ).session(session);
          if (!existingUnit) {
            throw new ApiError(
              400,
              `Unit with ID ${product.quantityUnit} not found for product ${product.itemName}`,
            );
          }
        }
      }
    }
    // --- End Validation ---

    const lc = await LC.findById(id).session(session);

    if (!lc) {
      throw new ApiError(404, "LC not found");
    }
    if (lc.isDeleted) {
      throw new ApiError(400, "Cannot update a deleted LC.");
    }

    // Preserve the original lcNumber to prevent it from being updated
    const originalLcNumber = lc.basicInfo.lcNumber;
    if (updateData.basicInfo) {
      updateData.basicInfo.lcNumber = originalLcNumber;
    }

    // --- Document Management ---
    const existingDocs = lc.documentsNotes.uploadedDocuments || [];
    const incomingDocs = updateData.documentsNotes?.uploadedDocuments || [];
    let finalDocs = [];

    const docsToDelete = existingDocs.filter(
      (doc) =>
        !incomingDocs.some(
          (inDoc) => inDoc._id.toString() === doc._id.toString(),
        ),
    );

    for (const doc of docsToDelete) {
      await storageUtil.deleteLcDocument(
        lc.basicInfo.lcNumber,
        doc.path,
        doc.storedName,
      );
      storageUtil.cleanupEmptyLcDirectory(lc.basicInfo.lcNumber, doc.path);
    }

    finalDocs = existingDocs.filter((doc) =>
      incomingDocs.some((inDoc) => inDoc._id.toString() === doc._id.toString()),
    );

    if (uploadedFiles.length > 0) {
      preparedNewDocs = uploadedFiles.map((file) =>
        storageUtil.prepareDocumentData(file),
      );
      finalDocs.push(...preparedNewDocs.map((p) => p.docData));
    }

    if (!updateData.documentsNotes) {
      updateData.documentsNotes = {};
    }
    updateData.documentsNotes.uploadedDocuments = finalDocs;
    updateData.modifiedBy = req.user?._id || null;

    // Apply all updates
    // Critical: Reconcile financial costs BEFORE saving
    await _reconcileLCCosts(lc, updateData, session, req.businessTimezone);

    lc.set(updateData);

    const updatedLC = await lc.save({ session });

    if (preparedNewDocs.length > 0) {
      for (const preparedDoc of preparedNewDocs) {
        await storageUtil.commitDocument(
          preparedDoc.tempPath,
          preparedDoc.docData,
          lc.basicInfo.lcNumber,
        );
      }
    }

    await session.commitTransaction();
    session.endSession();

    return res
      .status(200)
      .json(new ApiResponse(200, updatedLC, "LC updated successfully"));
  } catch (error) {
    await session.abortTransaction();
    session.endSession();

    await storageUtil.cleanupTempFiles(uploadedFiles);

    if (error instanceof ApiError) {
      return next(error);
    }
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `An LC with the same ${field} '${value}' already exists.`,
        ),
      );
    }
    if (error.name === "ValidationError") {
      const firstErrorField = Object.keys(error.errors)[0];
      const userFriendlyMessage =
        error.errors[firstErrorField]?.message || "Validation failed.";
      return next(new ApiError(400, userFriendlyMessage, error.errors));
    }
    next(
      new ApiError(
        500,
        error.message || "Something went wrong while updating the LC.",
      ),
    );
  }
}

async function deleteDocument(req, res, next) {
  const { lcId, docId } = req.params;
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const lc = await LC.findById(lcId).session(session);
    if (!lc) {
      throw new ApiError(404, "LC not found");
    }

    const doc = lc.documentsNotes.uploadedDocuments.id(docId);
    if (!doc) {
      throw new ApiError(404, "Document not found in this LC");
    }

    // 1. Delegate physical file deletion to the storage utility
    await storageUtil.deleteLcDocument(
      lc.basicInfo.lcNumber,
      doc.path,
      doc.storedName,
    );

    // 2. Remove the sub-document from the array using Mongoose's .pull() method.
    lc.documentsNotes.uploadedDocuments.pull(docId);
    await lc.save({ session });

    await session.commitTransaction();
    session.endSession();

    // Fire-and-forget the cleanup, no need to wait for it
    storageUtil.cleanupEmptyLcDirectory(lc.basicInfo.lcNumber, doc.path);

    return res
      .status(200)
      .json(new ApiResponse(200, lc, "Document deleted successfully."));
  } catch (error) {
    await session.abortTransaction();
    session.endSession();

    if (error instanceof ApiError) {
      return next(error);
    }
    next(
      new ApiError(
        500,
        error.message || "Something went wrong while deleting the document.",
      ),
    );
  }
}

async function deleteLC(req, res, next) {
  // Start a database session
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { id } = req.params;

    // Check if any active products are linked with this LC
    const linkedProduct = await Product.findOne({
      LC: id,
      isDeleted: { $ne: true },
    }).session(session);

    if (linkedProduct) {
      throw new ApiError(
        409, // Conflict
        `This LC cannot be deleted because it is still linked with the product "${linkedProduct.name}". Please remove or unlink all related products first.`,
      );
    }

    // Soft delete the LC
    const deletedLC = await LC.findByIdAndUpdate(
      id,
      {
        isDeleted: true,
        deletedBy: req.user?._id || null,
      },
      { session, new: true },
    );

    if (!deletedLC) {
      throw new ApiError(404, "The LC you are trying to delete was not found.");
    }

    // Move LC to trash
    await Trash.create({
      docId: deletedLC._id,
      model: "LC",
      deletedBy: req.user._id,
      deletedAt: now(),
    });

    // Daily cash check before reversing LC costs
    const today = startOfDay(now(), req.businessTimezone);
    const dailyCash = await DailyCash.findOne({
      date: today,
      status: "Open",
    }).session(session);

    if (!dailyCash) {
      throw new ApiError(
        400,
        `Daily cash is closed for ${today.toDateString()}. LC cost reversal is not allowed.`,
      );
    }

    // All LC cost sections
    const sectionsWithCosts = [
      deletedLC.financialInfo,
      deletedLC.shippingCustomsInfo,
      deletedLC.agentTransportInfo,
      deletedLC.otherExpenses,
      deletedLC.documentProductInfo,
    ];

    // Reverse each LC cost
    for (const section of sectionsWithCosts) {
      if (section && section.costs) {
        for (const cost of section.costs) {
          if (cost.accountId && cost.amount > 0) {
            const account = await Account.findById(cost.accountId).session(
              session,
            );

            if (account) {
              // Add money back to account
              account.balance += cost.amount;
              await account.save({ session });

              // Create reversal transaction
              await Transaction.create(
                [
                  {
                    accountId: cost.accountId,
                    date: now(),
                    description: `LC cost reversal processed for "${cost.name}". Amount returned to account due to LC deletion. LC Number: ${deletedLC.basicInfo.lcNumber}.`,
                    transactionType: "Income",
                    amount: cost.amount,
                    name: `LC Cost Reversal - ${cost.name}`,
                    source: "Auto",
                    category: "LC Reversal",
                    paymentMethod: cost.paymentMethod,
                    reference: deletedLC._id,
                    referenceModel: "LC",
                    miscReference: {
                      lcNumber: deletedLC.basicInfo.lcNumber,
                      costName: cost.name,
                      costAmount: cost.amount,
                      paymentMethod: cost.paymentMethod,
                      accountId: cost.accountId,
                    },
                  },
                ],
                { session },
              );
            }
          }
        }
      }
    }

    // Commit transaction
    await session.commitTransaction();
    session.endSession();

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          deletedLC,
          "LC has been deleted successfully and all related costs have been reversed.",
        ),
      );
  } catch (error) {
    await session.abortTransaction();
    session.endSession();

    if (error instanceof ApiError) {
      return next(error);
    }

    // Handle duplicate key error
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `Another record already exists with the same ${field}: "${value}".`,
        ),
      );
    }

    // Handle validation errors
    if (error.name === "ValidationError") {
      const firstErrorField = Object.keys(error.errors)[0];
      let userFriendlyMessage = "Validation failed. Please check your input.";

      if (firstErrorField) {
        userFriendlyMessage = `The field "${firstErrorField}" is required or invalid.`;
      }

      return next(new ApiError(400, userFriendlyMessage, error.errors));
    }

    // Fallback error
    next(
      new ApiError(
        500,
        "Failed to delete the LC due to an unexpected error. Please try again.",
      ),
    );
  }
}

async function getAllCompletedLCs(_, res, next) {
  try {
    const lcs = await LC.find({
      "basicInfo.status": { $in: ["Active", "Completed"] },
      isDeleted: false,
    })
      .populate("productInfo.quantityUnit", "name type conversionFactor")
      .select(
        "_id basicInfo.lcNumber basicInfo.status productInfo basicInfo.supplierName basicInfo.supplierCountry",
      )
      .lean();
    return res
      .status(200)
      .json(new ApiResponse(200, lcs, "All LCs fetched successfully"));
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
          `A document with the same ${field} '${value}' already exists.`,
        ),
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
    next(new ApiError(500, error.message || "Something went wrong"));
  }
}

async function getLCCountsByStatus(req, res, next) {
  try {
    const counts = await LC.aggregate([
      { $match: { isDeleted: false } },
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
          "LC counts by status fetched successfully",
        ),
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
          `A document with the same ${field} '${value}' already exists.`,
        ),
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
    next(new ApiError(500, error.message || "Something went wrong"));
  }
}

async function downloadDocument(req, res, next) {
  try {
    const { lcId, storedName } = req.params;

    const lc = await LC.findById(lcId);
    if (!lc || lc.isDeleted) {
      throw new ApiError(404, "LC not found");
    }

    const doc = lc.documentsNotes.uploadedDocuments.find(
      (d) => d.storedName === storedName,
    );
    if (!doc) {
      throw new ApiError(404, "Document not found in this LC");
    }

    const filePath = path.join(
      storageUtil.LC_DOCUMENTS_DIR,
      doc.path,
      lc.basicInfo.lcNumber,
      storedName,
    );

    // Set headers for inline display (viewing in browser) and correct filename for download
    res.setHeader("Content-Type", doc.mimeType);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${doc.originalName}"`,
    );

    res.sendFile(filePath, (err) => {
      if (err) {
        if (err.code === "ENOENT") {
          return next(new ApiError(404, "File not found on server."));
        } else {
          logger.error(`Failed to send file: ${filePath}`, err);
          return next(new ApiError(500, "Could not send the file."));
        }
      }
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    // The res.sendFile callback handles ENOENT, but a check before might also throw it
    if (error.code === "ENOENT") {
      return next(new ApiError(404, "File not found."));
    }
    next(
      new ApiError(
        500,
        error.message || "Something went wrong while downloading the document.",
      ),
    );
  }
}

async function exportLCAsPDF(req, res, next) {
  try {
    const { id } = req.params;

    const lc = await LC.findById(id)
      .populate("productInfo.quantityUnit", "name type conversionFactor")
      .populate("basicInfo.accountId")
      .populate("financialInfo.costs.accountId")
      .populate("shippingCustomsInfo.costs.accountId")
      .populate("agentTransportInfo.costs.accountId")
      .populate("otherExpenses.costs.accountId");

    if (!lc) {
      return res.status(404).json({
        error: "LC not found",
        message: "No LC found with the provided ID",
      });
    }

    // Validate LC has minimum required data BEFORE calling generateLCPDF
    if (!lc.basicInfo) {
      return res.status(400).json({
        error: "Invalid LC data",
        message: "LC is missing basic information",
      });
    }

    if (!lc.basicInfo.lcNumber) {
      return res.status(400).json({
        error: "Invalid LC data",
        message: "LC is missing LC Number",
      });
    }

    if (!lc.productInfo || lc.productInfo.length === 0) {
      return res.status(400).json({
        error: "Invalid LC data",
        message: "LC must have at least one product",
      });
    }

    // Additional validation - check if financial info exists
    if (!lc.financialInfo || !lc.financialInfo.lcAmountUsd) {
      return res.status(400).json({
        error: "Invalid LC data",
        message: "LC is missing financial information",
      });
    }

    // Call the PDF generator - it should handle the response directly
    // DO NOT await if generateLCPDF uses streaming
    const result = generateLCPDF(lc, res);

    // If generateLCPDF returns a promise, await it
    if (result && typeof result.then === "function") {
      await result;
    }

    // DO NOT send any response here - generateLCPDF handles it
  } catch (error) {
    // Check if response was already sent, which can happen during streaming
    if (res.headersSent) {
      logger.error(
        "An error occurred during PDF streaming after headers were sent:",
        error,
      );
      // Can't send a new response, but we should log it. The connection will likely be terminated.
      return;
    }

    // If it's a known API error, pass it along.
    if (error instanceof ApiError) {
      return next(error);
    }

    // For all other errors, log them and send a generic response.
    logger.error("Error during PDF export:", error);
    next(new ApiError(500, "Failed to generate PDF. Please try again."));
  }
}

async function getLCSummary(req, res, next) {
  try {
    // 1. Get parameters
    const { status, sortBy, sortOrder } = req.query;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const skip = (page - 1) * limit;

    // 2. Build filter and sort objects
    const filter = { isDeleted: false };
    if (status) {
      filter["basicInfo.status"] = status;
    }

    const sort = {};
    const sortOrderValue = sortOrder === "desc" ? -1 : 1;
    if (sortBy === "openingDate") {
      sort["basicInfo.lcOpeningDate"] = sortOrderValue;
    } else if (sortBy === "dueDate") {
      sort["shippingCustomsInfo.expectedArrivalDate"] = sortOrderValue;
    } else if (sortBy === "totalCost") {
      sort["totalCost"] = sortOrderValue;
    } else if (sortBy === "lcNumber") {
      sort["basicInfo.lcNumber"] = sortOrderValue;
    } else if (sortBy === "supplierName") {
      sort["basicInfo.supplierName"] = sortOrderValue;
    } else {
      sort["createdAt"] = -1;
    }

    // 3. Perform queries
    const [totalDocuments, lcs] = await Promise.all([
      LC.countDocuments(filter),
      LC.find(filter)
        .populate("productInfo.quantityUnit", "name")
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    // 4. Map to summary format
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
      totalCost: lc.totalCost, // Use the stored value
    }));

    // 5. Construct response
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
        new ApiResponse(200, responseData, "LCs summary fetched successfully"),
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
          `A document with the same ${field} '${value}' already exists.`,
        ),
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
    next(new ApiError(500, error.message || "Something went wrong"));
  }
}

async function addExpenseToLC(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { lcId, category, expense } = req.body;

    // 1. Validate input
    if (!lcId) {
      throw new ApiError(400, "LC ID is required in the request body.");
    }
    if (!category || !expense) {
      throw new ApiError(400, "Category and expense data are required.");
    }

    const validCategories = [
      "financialInfo",
      "shippingCustomsInfo",
      "agentTransportInfo",
      "otherExpenses",
      "documentProductInfo",
    ];
    if (!validCategories.includes(category)) {
      throw new ApiError(
        400,
        `Invalid category. Must be one of: ${validCategories.join(", ")}`,
      );
    }

    // 2. Find the LC
    const lc = await LC.findById(lcId).session(session);
    if (!lc) {
      throw new ApiError(404, "LC not found");
    }
    if (lc.isDeleted) {
      throw new ApiError(400, "Cannot add expense to a deleted LC.");
    }

    // 3. Add the expense to the correct category
    if (!lc[category]) {
      lc[category] = { costs: [] };
    } else if (!lc[category].costs) {
      lc[category].costs = [];
    }

    // Clean up empty accountId in the new expense to prevent CastError
    if (expense && (!expense.accountId || expense.accountId === "")) {
      expense.accountId = null; // Set to null if empty string
    }

    lc[category].costs.push(expense);

    // 4. Handle the financial transaction for the new expense
    await _handleLCCostTransaction(expense, lc, session);

    // 5. Save the updated LC
    await lc.save({ session });

    await session.commitTransaction();
    session.endSession();

    // 6. Repopulate all fields to be consistent with GET responses
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
      { path: "documentProductInfo.costs.accountId" },
      { path: "documentProductInfo.products.quantityUnit", select: "name type conversionFactor" },
    ]);

    return res
      .status(200)
      .json(new ApiResponse(200, lc, "Expense added successfully"));
  } catch (error) {
    await session.abortTransaction();
    session.endSession();

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
          `An LC expense with the same ${field} '${value}' already exists.`,
        ),
      ); // Specific message for LC expense
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
    next(new ApiError(500, error.message || "Something went wrong"));
  }
}

async function searchLCSummary(req, res, next) {
  try {
    // 1. Get parameters
    const { searchQuery, status, sortBy, sortOrder } = req.query;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const skip = (page - 1) * limit;

    // 2. Build filter and sort objects
    const filter = { isDeleted: false };
    if (status) {
      filter["basicInfo.status"] = status;
    }
    if (searchQuery) {
      const regex = new RegExp(searchQuery, "i");
      filter["$or"] = [
        { "basicInfo.lcNumber": regex },
        { "basicInfo.supplierName": regex },
        { "productInfo.itemName": regex },
      ];
    }

    const sort = {};
    const sortOrderValue = sortOrder === "desc" ? -1 : 1;
    if (sortBy === "openingDate") {
      sort["basicInfo.lcOpeningDate"] = sortOrderValue;
    } else if (sortBy === "dueDate") {
      sort["shippingCustomsInfo.expectedArrivalDate"] = sortOrderValue;
    } else if (sortBy === "totalCost") {
      sort["totalCost"] = sortOrderValue;
    } else if (sortBy === "lcNumber") {
      sort["basicInfo.lcNumber"] = sortOrderValue;
    } else if (sortBy === "supplierName") {
      sort["basicInfo.supplierName"] = sortOrderValue;
    } else {
      sort["createdAt"] = -1;
    }

    // 3. Perform queries
    const [totalDocuments, lcs] = await Promise.all([
      LC.countDocuments(filter),
      LC.find(filter)
        .populate("productInfo.quantityUnit", "name")
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    // 4. Map to summary format
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
      totalCost: lc.totalCost, // Use the stored value
    }));

    // 5. Construct response
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
        new ApiResponse(
          200,
          responseData,
          "LCs summary search completed successfully",
        ),
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
          `A document with the same ${field} '${value}' already exists.`,
        ),
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
    next(new ApiError(500, error.message || "Something went wrong"));
  }
}

/**
 * @param {object} originalLC The original LC document from DB
 * @param {object} updateData The data being updated
 * @param {mongoose.ClientSession} session
 * @param {string} timezone
 */
async function _reconcileLCCosts(originalLC, updateData, session, timezone) {
  const sectionsWithCosts = [
    "financialInfo",
    "shippingCustomsInfo",
    "agentTransportInfo",
    "otherExpenses",
    "documentProductInfo",
  ];

  // 1. Check Daily Cash Status (Gatekeeper)
  const today = startOfDay(now(), timezone);
  const dailyCash = await DailyCash.findOne({
    date: today,
    status: "Open",
    isDeleted: false,
  }).session(session);

  let cashCheckPerformed = false;
  const ensureCashOpen = () => {
    if (!cashCheckPerformed) {
      // Slight optimization: only throw if we actually need to write
      if (!dailyCash) {
        throw new ApiError(
          400,
          `Daily cash is closed for ${today.toDateString()}. Cannot update LC costs.`,
        );
      }
      cashCheckPerformed = true;
    }
  };

  for (const section of sectionsWithCosts) {
    // If the section is not in updateData, it means no changes for this section
    if (!updateData[section] || !updateData[section].costs) continue;

    const originalCosts = originalLC[section]?.costs || [];
    const newCosts = updateData[section].costs;

    // A. Detect Deleted or Modify-requiring Costs (Present in Original but missing or changed in New)
    for (const oldCost of originalCosts) {
      // Only care about costs that had financial impact
      if (!oldCost.accountId || !oldCost.amount) continue;

      const matchingNewCost = newCosts.find(
        (nc) => nc._id && nc._id.toString() === oldCost._id.toString(),
      );

      // If deleted OR significantly changed (amount/account), we REVERSE the old cost
      // Note: For simplicity and audit safety, if amount/account changes, we Reverse Old + Apply New
      if (
        !matchingNewCost ||
        matchingNewCost.amount !== oldCost.amount ||
        matchingNewCost.accountId !== oldCost.accountId.toString()
      ) {
        ensureCashOpen();

        const account = await Account.findById(oldCost.accountId).session(
          session,
        );
        if (account) {
          account.balance += oldCost.amount; // Refund
          await account.save({ session });

          await Transaction.create(
            [
              {
                accountId: oldCost.accountId,
                date: now(),
                description: `Update Reversal: ${oldCost.name} for LC ${originalLC.basicInfo.lcNumber}`,
                transactionType: "Income",
                amount: oldCost.amount,
                name: `LC Cost Adjustment: ${oldCost.name}`,
                source: "Auto",
                category: "LC Reversal",
                paymentMethod: oldCost.paymentMethod,
                reference: originalLC._id,
                referenceModel: "LC",
                miscReference: {
                  lcNumber: originalLC.basicInfo.lcNumber,
                  costName: oldCost.name,
                  modificationType: "Update/Delete",
                },
              },
            ],
            { session },
          );
        }
      }
    }

    // B. Detect New or Updated Costs
    for (const newCost of newCosts) {
      // Skip invalid costs
      if (!newCost.accountId || !newCost.amount) continue;

      const isNew = !newCost._id;
      const matchingOldCost = originalCosts.find(
        (oc) => newCost._id && oc._id.toString() === newCost._id.toString(),
      );

      // If it's New OR (Old exists BUT changed), we apply the NEW cost
      if (
        isNew ||
        (matchingOldCost &&
          (matchingOldCost.amount !== newCost.amount ||
            matchingOldCost.accountId.toString() !== newCost.accountId))
      ) {
        ensureCashOpen();

        const account = await Account.findById(newCost.accountId).session(
          session,
        );
        if (!account)
          throw new ApiError(400, `Account not found for cost ${newCost.name}`);

        if (account.balance < newCost.amount) {
          throw new ApiError(
            400,
            `Insufficient balance in ${account.accountName} for updated cost ${newCost.name}`,
          );
        }

        account.balance -= newCost.amount; // Deduct
        await account.save({ session });

        await Transaction.create(
          [
            {
              accountId: newCost.accountId,
              date: now(), // Use current time for the adjustment
              description: `LC Cost ${isNew ? "Added" : "Updated"}: ${newCost.name} for LC ${originalLC.basicInfo.lcNumber}`,
              transactionType: "Expense",
              amount: newCost.amount,
              name: `LC Cost: ${newCost.name}`,
              source: "Auto",
              category: "LC",
              paymentMethod: newCost.paymentMethod,
              reference: originalLC._id,
              referenceModel: "LC",
              miscReference: {
                lcNumber: originalLC.basicInfo.lcNumber,
                costName: newCost.name,
                modificationType: isNew ? "Create" : "Update",
              },
            },
          ],
          { session },
        );
      }
    }
  }
}

async function getActiveLcs(req, res, next) {
  try {
    const lcs = await LC.find({
      "basicInfo.status": /^Active$/i,
      isDeleted: false,
    })
      .populate("productInfo.quantityUnit", "name type conversionFactor")
      .select("_id basicInfo.lcNumber basicInfo.status productInfo")
      .lean();
    return res
      .status(200)
      .json(new ApiResponse(200, lcs, "All LCs fetched successfully"));
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
          `A document with the same ${field} '${value}' already exists.`,
        ),
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
    next(new ApiError(500, error.message || "Something went wrong"));
  }
}

module.exports = {
  createLC,
  getLCById,
  updateLC,
  deleteLC,
  getAllCompletedLCs,
  upload,
  getLCCountsByStatus,
  downloadDocument,
  exportLCAsPDF,
  getLCSummary,
  addExpenseToLC,
  searchLCSummary,
  _reconcileLCCosts,
  deleteDocument,
  getActiveLcs,
};
