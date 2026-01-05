const crypto = require("crypto");
const fs = require("fs").promises;
const path = require("path");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const { generateLCPDF } = require("../utils/LC_pdfGenerator");
const { ApiError } = require("../utils/ApiError");
const logger = require("../utils/logger");
const { ApiResponse } = require("../utils/ApiResponse");
const LC = require("../models/lc.model");
const Unit = require("../models/unit.model"); // Import Unit model
const Account = require("../models/account.model"); // Import Account model explicitly
const DailyCash = require("../models/dailyCash.model"); // Added
const Transaction = require("../models/transaction.model");
const Product = require("../models/product.model"); // Import Product model
require("../models/account.model"); // Ensure Account model is registered for population
const mongoose = require("mongoose"); // Added
const Trash = require("../models/trash.model");

//- Ensure the uploads directory exists
const uploadsBaseDir = path.join(__dirname, "../uploads");
const lcDocumentsDir = path.join(uploadsBaseDir, "lc_documents");
const tempDir = path.join(uploadsBaseDir, "temp");

async function ensureDir(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }
}

ensureDir(uploadsBaseDir);
ensureDir(lcDocumentsDir);
ensureDir(tempDir);


const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, tempDir);
  },
  filename: function (req, file, cb) {
    // Use a temporary unique name
    cb(null, `${uuidv4()}-${file.originalname}`);
  },
});

const upload = multer({ storage: storage });

async function createLC(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  const tempFiles = req.files ? req.files.map(f => f.path) : [];

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

    // --- Validation (Copied from your existing logic) ---
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
            const validationError = {
              field: `${section}.costs.accountId`,
              message: `Account ID is required for ${cost.paymentMethod} payment method in cost "${cost.name}".`,
            };
            throw new ApiError(400, validationError.message, [validationError]);
          }
          if (cost.accountId) {
            const existingAccount = await Account.findById(cost.accountId).session(session);
            if (!existingAccount) {
               const validationError = {
                field: `${section}.costs.accountId`,
                message: `Account with ID ${cost.accountId} not found for cost "${cost.name}".`,
              };
              throw new ApiError(400, validationError.message, [validationError]);
            }
            if (existingAccount.accountType !== cost.paymentMethod) {
              const validationError = {
                field: `${section}.costs.accountId`,
                message: `Payment method '${cost.paymentMethod}' requires a '${cost.paymentMethod}' account, but a '${existingAccount.accountType}' account was provided for cost "${cost.name}".`,
              };
              throw new ApiError(400, validationError.message, [validationError]);
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
            const validationError = {
              field: "quantityUnit",
              message: `Unit with ID ${product.quantityUnit} not found for product ${product.itemName}`,
            };
            throw new ApiError(400, validationError.message, [validationError]);
          }
        }
      }
    }
    // --- End Validation ---

    // 1. Pre-generate a new ID for the LC
    const newLcId = new mongoose.Types.ObjectId();
    const newLcDir = path.join(lcDocumentsDir, newLcId.toString());
    await ensureDir(newLcDir);

    // 2. Move files and prepare document data
    const uploadedDocumentsData = [];
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const oldPath = file.path;
        const newPath = path.join(newLcDir, file.filename); // file.filename has the unique name
        await fs.rename(oldPath, newPath);

        uploadedDocumentsData.push({
          originalName: file.originalname,
          storedName: file.filename,
          mimeType: file.mimetype,
          sizeBytes: file.size,
        });
      }
    }

    // 3. Prepare the final LC data for a single save operation
    if (!lcData.documentsNotes) {
      lcData.documentsNotes = {};
    }
    lcData.documentsNotes.uploadedDocuments = uploadedDocumentsData;
    lcData._id = newLcId; // Assign the pre-generated ID

    // 4. Create and save the LC in a single atomic operation
    const lc = new LC(lcData);
    await lc.save({ session });

    // 5. Handle post-save operations like transactions
    for (const section of sectionsWithCosts) {
      if (lcData[section] && lcData[section].costs) {
        for (const cost of lcData[section].costs) {
          await _handleLCCostTransaction(cost, lc, session);
        }
      }
    }

    await session.commitTransaction();
    session.endSession();

    return res
      .status(201)
      .json(new ApiResponse(201, lc, "LC created successfully"));
  } catch (error) {
    await session.abortTransaction();
    session.endSession();

    // Cleanup temporary files and any moved files on error
    for (const filePath of tempFiles) {
      try {
        await fs.unlink(filePath);
      } catch (unlinkError) {
        if (unlinkError.code !== 'ENOENT') {
          logger.error(`Failed to delete temporary file on error: ${filePath}`, unlinkError);
        }
      }
    }

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
    const costDate = cost.date || new Date();
    const costDateNormalized = new Date(costDate);
    costDateNormalized.setHours(0, 0, 0, 0);

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
  const tempFiles = req.files ? req.files.map(f => f.path) : [];

  try {
    let updateData;
    if (req.body.lcData) {
      updateData = JSON.parse(req.body.lcData);
    } else if (req.body.lc_data) {
      // Also check for snake_case
      updateData = JSON.parse(req.body.lc_data);
    } else {
      updateData = req.body;
    }

    const lc = await LC.findById(id).session(session);

    if (!lc) {
      throw new ApiError(404, "LC not found");
    }
    if (lc.isDeleted) {
      throw new ApiError(400, "Cannot update a deleted LC.");
    }
    
    // --- Document Management ---
    const lcSpecificDir = path.join(lcDocumentsDir, lc._id.toString());
    await ensureDir(lcSpecificDir);

    const existingDocs = lc.documentsNotes.uploadedDocuments || [];
    const incomingDocs = updateData.documentsNotes?.uploadedDocuments || [];
    const finalDocs = [];

    // 1. Identify and delete documents that were removed by the user
    const docsToDelete = existingDocs.filter(
      (doc) => !incomingDocs.some((inDoc) => inDoc._id.toString() === doc._id.toString())
    );

    for (const doc of docsToDelete) {
      const filePath = path.join(lcSpecificDir, doc.storedName);
      try {
        await fs.unlink(filePath);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          logger.error(`Failed to delete document file: ${filePath}`, err);
        }
      }
    }

    // 2. Keep the documents that were not removed
    for (const inDoc of incomingDocs) {
        const existingDoc = existingDocs.find(d => d._id.toString() === inDoc._id.toString());
        if(existingDoc){
            finalDocs.push(existingDoc);
        }
    }
    
    // 3. Process and add new documents
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const newPath = path.join(lcSpecificDir, file.filename);
        await fs.rename(file.path, newPath); // Move from temp to permanent

        finalDocs.push({
          originalName: file.originalname,
          storedName: file.filename,
          mimeType: file.mimetype,
          sizeBytes: file.size,
        });
      }
    }

    // Create the documentsNotes object if it doesn't exist
    if (!lc.documentsNotes) {
      lc.documentsNotes = {};
    }
    
    // Update the document array and note
    lc.documentsNotes.uploadedDocuments = finalDocs;
    if(updateData.documentsNotes?.note !== undefined) {
      lc.documentsNotes.note = updateData.documentsNotes.note;
    }

    // --- Other Field Updates ---
    // Prevent direct updates to sensitive fields that are managed by other endpoints
    delete updateData.financialInfo;
    delete updateData.shippingCustomsInfo;
    delete updateData.agentTransportInfo;
    delete updateData.otherExpenses;
    delete updateData.totalCost;
    delete updateData.documentsNotes; // We've handled this manually

    // Apply the rest of the updates
    Object.assign(lc, updateData);
    
    const updatedLC = await lc.save({ session });
    
    await session.commitTransaction();
    session.endSession();

    return res.status(200).json(new ApiResponse(200, updatedLC, "LC updated successfully"));
  } catch (error) {
    await session.abortTransaction();
    session.endSession();

    // Cleanup temporary files on any error
    for (const filePath of tempFiles) {
      try {
        await fs.unlink(filePath);
      } catch (unlinkError) {
         if (unlinkError.code !== 'ENOENT') {
            logger.error(`Failed to delete temporary file on error: ${filePath}`, unlinkError);
         }
      }
    }

    if (error instanceof ApiError) {
      return next(error);
    }
    if (error.code === 11000) {
      return next(new ApiError(409, "An LC with the same details already exists."));
    }
    if (error.name === 'ValidationError') {
      return next(new ApiError(400, "Validation failed.", error.errors));
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

    // 1. Delete the physical file
    const filePath = path.join(lcDocumentsDir, lcId, doc.storedName);
    try {
      await fs.unlink(filePath);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.error(`Failed to delete document file that should exist: ${filePath}`, err);
        throw new ApiError(500, "Could not delete the document file from storage.");
      }
      // If file doesn't exist, we can still proceed to remove the DB record
      logger.warn(`Document file not found, but proceeding with DB record removal: ${filePath}`);
    }

    // 2. Remove the document sub-document from the array
    doc.remove();
    await lc.save({ session });

    await session.commitTransaction();
    session.endSession();

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
      deletedAt: new Date(),
    });

    // DailyCash Gatekeeper Check for reversal transactions
    const today = new Date();
    today.setHours(0, 0, 0, 0);
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
                date: new Date(), // Reversal transaction date is today
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

    // We need to find the LC to get the document's originalName
    const lc = await LC.findById(lcId);
    if (!lc || lc.isDeleted) {
      throw new ApiError(404, "LC not found");
    }

    const doc = lc.documentsNotes.uploadedDocuments.find(d => d.storedName === storedName);
    if (!doc) {
      throw new ApiError(404, "Document not found in this LC");
    }

    const filePath = path.join(lcDocumentsDir, lcId, storedName);

    // Check if file exists before sending
    await fs.access(filePath, fs.constants.F_OK);

    // Set headers for inline display (viewing in browser) and correct filename for download
    res.setHeader('Content-Type', doc.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${doc.originalName}"`);

    res.sendFile(filePath, (err) => {
      if (err) {
        // The initial check with fs.access should prevent most 'ENOENT' errors here
        // but we handle it just in case of a race condition.
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
    if (error.code === 'ENOENT') {
      return next(new ApiError(404, "File not found."));
    }
    next(new ApiError(500, error.message || "Something went wrong while downloading the document."));
  }
}


async function exportLCAsPDF(req, res, next) {
  try {
    const { id } = req.params;

    console.log('=== EXPORT LC DEBUG ===');
    console.log('LC ID:', id);

    const lc = await LC.findById(id)
      .populate("productInfo.quantityUnit", "name type conversionFactor")
      .populate("basicInfo.accountId")
      .populate("financialInfo.costs.accountId")
      .populate("shippingCustomsInfo.costs.accountId")
      .populate("agentTransportInfo.costs.accountId")
      .populate("otherExpenses.costs.accountId");

    console.log('LC Found:', !!lc);
    
    if (!lc) {
      console.log('LC not found in database');
      return res.status(404).json({ 
        error: "LC not found",
        message: "No LC found with the provided ID" 
      });
    }

    console.log('LC Basic Info:', JSON.stringify(lc.basicInfo, null, 2));
    console.log('LC Products:', lc.productInfo?.length || 0);
    console.log('LC Financial Info:', !!lc.financialInfo);

    // Validate LC has minimum required data BEFORE calling generateLCPDF
    if (!lc.basicInfo) {
      console.log('ERROR: Missing basicInfo');
      return res.status(400).json({ 
        error: "Invalid LC data",
        message: "LC is missing basic information" 
      });
    }

    if (!lc.basicInfo.lcNumber) {
      console.log('ERROR: Missing lcNumber');
      return res.status(400).json({ 
        error: "Invalid LC data",
        message: "LC is missing LC Number" 
      });
    }

    if (!lc.productInfo || lc.productInfo.length === 0) {
      console.log('WARNING: No products in LC');
      return res.status(400).json({ 
        error: "Invalid LC data",
        message: "LC must have at least one product" 
      });
    }

    // Additional validation - check if financial info exists
    if (!lc.financialInfo || !lc.financialInfo.lcAmountUsd) {
      console.log('ERROR: Missing financial information');
      return res.status(400).json({ 
        error: "Invalid LC data",
        message: "LC is missing financial information" 
      });
    }

    console.log('All validations passed. Calling generateLCPDF...');
    
    // Call the PDF generator - it should handle the response directly
    // DO NOT await if generateLCPDF uses streaming
    const result = generateLCPDF(lc, res);
    
    // If generateLCPDF returns a promise, await it
    if (result && typeof result.then === 'function') {
      await result;
    }
    
    console.log('PDF generation completed');
    
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
        new ApiResponse(200, responseData, "LCs summary fetched successfully")
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