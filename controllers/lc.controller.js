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
            throw new ApiError(400, `Account ID is required for ${cost.paymentMethod} payment method in cost "${cost.name}".`);
          }
          if (cost.accountId) {
            const existingAccount = await Account.findById(cost.accountId).session(session);
            if (!existingAccount) {
               throw new ApiError(400, `Account with ID ${cost.accountId} not found for cost "${cost.name}".`);
            }
            if (existingAccount.accountType !== cost.paymentMethod) {
              throw new ApiError(400, `Payment method '${cost.paymentMethod}' requires a '${cost.paymentMethod}' account, but a '${existingAccount.accountType}' account was provided for cost "${cost.name}".`);
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
            throw new ApiError(400, `Unit with ID ${product.quantityUnit} not found for product ${product.itemName}`);
          }
        }
      }
    }
    // --- End Validation ---

    // 1. Prepare document metadata without moving files
    const preparedDocs = uploadedFiles.map(file =>
      storageUtil.prepareDocumentData(file)
    );

    // 2. Prepare the final LC data for the database
    const newLcId = new mongoose.Types.ObjectId();
    if (!lcData.documentsNotes) {
      lcData.documentsNotes = {};
    }
    lcData.documentsNotes.uploadedDocuments = preparedDocs.map(p => p.docData);
    lcData._id = newLcId;

    // 3. Create and save the LC document
    const lc = new LC(lcData);
    await lc.save({ session });

    // 4. Handle post-save operations like transactions
    for (const section of sectionsWithCosts) {
      if (lcData[section] && lcData[section].costs) {
        for (const cost of lcData[section].costs) {
          await _handleLCCostTransaction(cost, lc, session);
        }
      }
    }

    // 5. If DB operations are successful, commit files to permanent storage
    for (const preparedDoc of preparedDocs) {
        await storageUtil.commitDocument(preparedDoc.tempPath, preparedDoc.docData, lc.basicInfo.lcNumber);
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
      return next(new ApiError(409, `An LC with the same ${field} '${value}' already exists.`));
    }
    if (error.name === 'ValidationError') {
      const firstErrorField = Object.keys(error.errors)[0];
      const userFriendlyMessage = `Validation failed: ${error.errors[firstErrorField].message}`;
      return next(new ApiError(400, userFriendlyMessage, error.errors));
    }

    next(new ApiError(500, error.message || "Something went wrong creating LC."));
  }
}


/**
 * @param {object} cost The cost object from the LC
 * @param {mongoose.Model} lc The LC document
 * @param {mongoose.ClientSession} session The mongoose session for the transaction
 */
async function _handleLCCostTransaction(cost, lc, session) {
    // Only process costs that have an account and a valid amount
    if (!cost.accountId || !cost.amount || cost.amount <= 0) {
        return;
    }

    // 1. DailyCash Gatekeeper Check
    const costDate = cost.date || now();
    const costDateNormalized = startOfDay(new Date(costDate));

    const openSession = await DailyCash.findOne({ date: costDateNormalized, status: "Open", isDeleted: false }).session(session);
    if (!openSession) {
        throw new ApiError(400, `Daily cash is closed for ${costDateNormalized.toDateString()}. Cannot record LC cost.`);
    }

    // 2. Find account and update balance
    const account = await Account.findById(cost.accountId).session(session);
    if (!account) {
        throw new ApiError(404, `Account with ID ${cost.accountId} not found for cost '${cost.name}'.`);
    }
    if (account.balance < cost.amount) {
        throw new ApiError(400, `Insufficient balance in account '${account.accountName}' for cost '${cost.name}'.`);
    }

    account.balance -= cost.amount;
    await account.save({ session });

    // 3. Create Transaction for the LC cost
    await Transaction.create([{
        accountId: cost.accountId,
        date: costDate,
        description: `LC Cost: ${cost.name} for LC Number: ${lc.basicInfo.lcNumber} via ${cost.paymentMethod} account.`,
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
    }], { session });
}


async function getAllLCs(_, res, next) {
  try {
    const lcs = await LC.find( { isDeleted: false } )
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
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(new ApiError(409, `A document with the same ${field} '${value}' already exists.`)); // Generic message
    }
    // Handle Mongoose validation errors
    if (error.name === 'ValidationError') {
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
      return next(new ApiError(409, `A document with the same ${field} '${value}' already exists.`)); // Generic message
    }
    // Handle Mongoose validation errors
    if (error.name === 'ValidationError') {
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
    const sectionsWithCosts = ["financialInfo", "shippingCustomsInfo", "agentTransportInfo", "otherExpenses"];
    for (const section of sectionsWithCosts) {
      if (updateData[section] && updateData[section].costs) {
        for (const cost of updateData[section].costs) {
          if (cost.accountId === '') { cost.accountId = null; }
          if (["Bank", "Mobile Banking", "Cash"].includes(cost.paymentMethod) && !cost.accountId) {
            throw new ApiError(400, `Account ID is required for ${cost.paymentMethod} payment method in cost "${cost.name}".`);
          }
          if (cost.accountId) {
            const existingAccount = await Account.findById(cost.accountId).session(session);
            if (!existingAccount) {
               throw new ApiError(400, `Account with ID ${cost.accountId} not found for cost "${cost.name}".`);
            }
            if (existingAccount.accountType !== cost.paymentMethod) {
              throw new ApiError(400, `Payment method '${cost.paymentMethod}' requires a '${cost.paymentMethod}' account, but a '${existingAccount.accountType}' account was provided.`);
            }
          }
        }
      }
    }
    if (updateData.productInfo && Array.isArray(updateData.productInfo)) {
      for (const product of updateData.productInfo) {
        if (product.quantityUnit) {
          if (typeof product.quantityUnit === "object" && product.quantityUnit.id) {
            product.quantityUnit = product.quantityUnit.id;
          }
          const existingUnit = await Unit.findById(product.quantityUnit).session(session);
          if (!existingUnit) {
            throw new ApiError(400, `Unit with ID ${product.quantityUnit} not found for product ${product.itemName}`);
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
      (doc) => !incomingDocs.some((inDoc) => inDoc._id.toString() === doc._id.toString())
    );

    for (const doc of docsToDelete) {
      await storageUtil.deleteLcDocument(lc.basicInfo.lcNumber, doc.path, doc.storedName);
      storageUtil.cleanupEmptyLcDirectory(lc.basicInfo.lcNumber, doc.path);
    }

    finalDocs = existingDocs.filter(
      (doc) => incomingDocs.some((inDoc) => inDoc._id.toString() === doc._id.toString())
    );
    
    if (uploadedFiles.length > 0) {
      preparedNewDocs = uploadedFiles.map(file => storageUtil.prepareDocumentData(file));
      finalDocs.push(...preparedNewDocs.map(p => p.docData));
    }

    if (!updateData.documentsNotes) {
        updateData.documentsNotes = {};
    }
    updateData.documentsNotes.uploadedDocuments = finalDocs;
    
    // Apply all updates
    lc.set(updateData);
    
    const updatedLC = await lc.save({ session });
    
    if (preparedNewDocs.length > 0) {
        for (const preparedDoc of preparedNewDocs) {
            await storageUtil.commitDocument(preparedDoc.tempPath, preparedDoc.docData, lc.basicInfo.lcNumber);
        }
    }

    await session.commitTransaction();
    session.endSession();

    return res.status(200).json(new ApiResponse(200, updatedLC, "LC updated successfully"));
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
        return next(new ApiError(409, `An LC with the same ${field} '${value}' already exists.`));
    }
    if (error.name === 'ValidationError') {
        const firstErrorField = Object.keys(error.errors)[0];
        const userFriendlyMessage = error.errors[firstErrorField]?.message || "Validation failed.";
        return next(new ApiError(400, userFriendlyMessage, error.errors));
    }
    next(new ApiError(500, error.message || "Something went wrong while updating the LC."));
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
    await storageUtil.deleteLcDocument(lc.basicInfo.lcNumber, doc.path, doc.storedName);

    // 2. Remove the sub-document from the array using Mongoose's .pull() method.
    lc.documentsNotes.uploadedDocuments.pull(docId);
    await lc.save({ session });

    await session.commitTransaction();
    session.endSession();

    // Fire-and-forget the cleanup, no need to wait for it
    storageUtil.cleanupEmptyLcDirectory(lc.basicInfo.lcNumber, doc.path);

    return res.status(200).json(new ApiResponse(200, lc, "Document deleted successfully."));

  } catch (error) {
    await session.abortTransaction();
    session.endSession();

    if (error instanceof ApiError) {
      return next(error);
    }
    next(new ApiError(500, error.message || "Something went wrong while deleting the document."));
  }
}


async function deleteLC(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;

    // Check if any products are linked to this LC before deleting
    const linkedProduct = await Product.findOne({ LC: id, isDeleted: { $ne: true } }).session(session);
    if (linkedProduct) {
      throw new ApiError(
        409, // Conflict
        `Cannot delete this LC because it is linked to product "${linkedProduct.name}" (and possibly others). You must delete or unlink the associated products first.`
      );
    }

    const deletedLC = await LC.findByIdAndUpdate(id, { isDeleted: true }, { session, new: true });

    if (!deletedLC) {
      throw new ApiError(404, "LC not found");
    }

    await Trash.create({
      docId: deletedLC._id,
      model: "LC",
      deletedBy: req.user._id,
      deletedAt: now(),
    });

    // DailyCash Gatekeeper Check for reversal transactions
    const today = startOfDay(now());
    const dailyCash = await DailyCash.findOne({ date: today, status: "Open" }).session(session);

    if (!dailyCash) {
        throw new ApiError(400, `Daily cash is closed for ${today.toDateString()}. Cannot reverse LC costs.`);
    }

    // Iterate through all cost sections of the deleted LC to create reversal transactions
    const sectionsWithCosts = [
      deletedLC.financialInfo,
      deletedLC.shippingCustomsInfo,
      deletedLC.agentTransportInfo,
      deletedLC.otherExpenses,
    ];

    for (const section of sectionsWithCosts) {
      if (section && section.costs) {
        for (const cost of section.costs) {
          if (cost.accountId && cost.amount > 0) { // Only reverse costs that had an account and amount
            const account = await Account.findById(cost.accountId).session(session);
            if (account) {
              account.balance += cost.amount; // Increase account balance (reversing the expense)
              await account.save({ session });

              // Create Reversal Transaction (Income type to offset original Expense)
              await Transaction.create([{
                accountId: cost.accountId,
                date: now(), // Reversal transaction date is today
                description: `Reversal of LC Cost: ${cost.name} for LC Number: ${deletedLC.basicInfo.lcNumber} via ${cost.paymentMethod} account.`,
                transactionType: "Income", // Reverses the Expense
                amount: cost.amount,
                name: `LC Cost Reversal: ${cost.name}`,
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
              }], { session });
            }
          }
        }
      }
    }

    await session.commitTransaction();
    session.endSession();

    return res
      .status(200)
      .json(new ApiResponse(200, deletedLC, "LC deleted successfully"));
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
      return next(new ApiError(409, `A document with the same ${field} '${value}' already exists.`)); // Generic message
    }
    // Handle Mongoose validation errors
    if (error.name === 'ValidationError') {
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

async function getAllCompletedLCs(_, res, next) {
  try {
    const lcs = await LC.find({ "basicInfo.status": /^Completed$/i, isDeleted: false })
      .populate("productInfo.quantityUnit", "name type conversionFactor")
      .select("_id basicInfo.lcNumber basicInfo.status productInfo");
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
      return next(new ApiError(409, `A document with the same ${field} '${value}' already exists.`)); // Generic message
    }
    // Handle Mongoose validation errors
    if (error.name === 'ValidationError') {
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
          "LC counts by status fetched successfully"
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
      return next(new ApiError(409, `A document with the same ${field} '${value}' already exists.`)); // Generic message
    }
    // Handle Mongoose validation errors
    if (error.name === 'ValidationError') {
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


async function getTotalLCCount(req, res, next) {
  try {
    const totalCount = await LC.countDocuments( { isDeleted: false } );

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
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(new ApiError(409, `A document with the same ${field} '${value}' already exists.`)); // Generic message
    }
    // Handle Mongoose validation errors
    if (error.name === 'ValidationError') {
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

    const doc = lc.documentsNotes.uploadedDocuments.find(d => d.storedName === storedName);
    if (!doc) {
      throw new ApiError(404, "Document not found in this LC");
    }

    const filePath = path.join(storageUtil.LC_DOCUMENTS_DIR, doc.path, lc.basicInfo.lcNumber, storedName);

    // Set headers for inline display (viewing in browser) and correct filename for download
    res.setHeader('Content-Type', doc.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${doc.originalName}"`);

    res.sendFile(filePath, (err) => {
      if (err) {
        if (err.code === 'ENOENT') {
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
    if (error.code === 'ENOENT') {
      return next(new ApiError(404, "File not found."));
    }
    next(new ApiError(500, error.message || "Something went wrong while downloading the document."));
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
        message: "No LC found with the provided ID" 
      });
    }

    // Validate LC has minimum required data BEFORE calling generateLCPDF
    if (!lc.basicInfo) {
      return res.status(400).json({ 
        error: "Invalid LC data",
        message: "LC is missing basic information" 
      });
    }

    if (!lc.basicInfo.lcNumber) {
      return res.status(400).json({ 
        error: "Invalid LC data",
        message: "LC is missing LC Number" 
      });
    }

    if (!lc.productInfo || lc.productInfo.length === 0) {
      return res.status(400).json({ 
        error: "Invalid LC data",
        message: "LC must have at least one product" 
      });
    }

    // Additional validation - check if financial info exists
    if (!lc.financialInfo || !lc.financialInfo.lcAmountUsd) {
      return res.status(400).json({ 
        error: "Invalid LC data",
        message: "LC is missing financial information" 
      });
    }

    // Call the PDF generator - it should handle the response directly
    // DO NOT await if generateLCPDF uses streaming
    const result = generateLCPDF(lc, res);
    
    // If generateLCPDF returns a promise, await it
    if (result && typeof result.then === 'function') {
      await result;
    }
    
    // DO NOT send any response here - generateLCPDF handles it

  } catch (error) {
    // Check if response was already sent, which can happen during streaming
    if (res.headersSent) {
      logger.error('An error occurred during PDF streaming after headers were sent:', error);
      // Can't send a new response, but we should log it. The connection will likely be terminated.
      return;
    }

    // If it's a known API error, pass it along.
    if (error instanceof ApiError) {
      return next(error);
    }
    
    // For all other errors, log them and send a generic response.
    logger.error('Error during PDF export:', error);
    next(new ApiError(500, "Failed to generate PDF. Please try again."));
  }
}
async function getActiveLcs(req,res,next){
  try {
    const lcs = await LC.find({ "basicInfo.status": /^Active$/i, isDeleted: false })
      .populate("productInfo.quantityUnit", "name type conversionFactor")
      .select("_id basicInfo.lcNumber basicInfo.status productInfo");
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
      return next(new ApiError(409, `A document with the same ${field} '${value}' already exists.`)); // Generic message
    }
    // Handle Mongoose validation errors
    if (error.name === 'ValidationError') {
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
        .limit(limit),
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
          "LCs summary fetched successfully"
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
      return next(new ApiError(409, `A document with the same ${field} '${value}' already exists.`)); // Generic message
    }
    // Handle Mongoose validation errors
    if (error.name === 'ValidationError') {
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
    ];
    if (!validCategories.includes(category)) {
      throw new ApiError(
        400,
        `Invalid category. Must be one of: ${validCategories.join(", ")}`
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
    if (expense && (!expense.accountId || expense.accountId === '')) {
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
      return next(new ApiError(409, `An LC expense with the same ${field} '${value}' already exists.`)); // Specific message for LC expense
    }

    // Handle Mongoose validation errors
    if (error.name === 'ValidationError') {
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
        .limit(limit),
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
          "LCs summary search completed successfully"
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
      return next(new ApiError(409, `A document with the same ${field} '${value}' already exists.`)); // Generic message
    }
    // Handle Mongoose validation errors
    if (error.name === 'ValidationError') {
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
  deleteDocument,
};