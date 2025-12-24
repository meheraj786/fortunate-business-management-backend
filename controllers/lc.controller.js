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
const DailyCash = require("../models/dailyCash.model"); // Added
const Transaction = require("../models/transaction.model");
require("../models/account.model"); // Ensure Account model is registered for population
const mongoose = require("mongoose"); // Added

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
  const session = await mongoose.startSession();
  session.startTransaction();
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

    const sectionsWithCosts = [
      "financialInfo",
      "shippingCustomsInfo",
      "agentTransportInfo",
      "otherExpenses",
    ];
    for (const section of sectionsWithCosts) {
      if (lcData[section] && lcData[section].costs) {
        for (const cost of lcData[section].costs) {
          // Clean up empty accountId in costs to prevent CastError
          if (!cost.accountId) {
            cost.accountId = null;
          }

          // Validate that accountId is present for account-based payments
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

          // If accountId is provided, validate it
          if (cost.accountId) {
            const existingAccount = await Account.findById(cost.accountId).session(session);
            if (!existingAccount) {
              const validationError = {
              field: `${section}.costs.accountId`,
              message: `Account with ID ${cost.accountId} not found for cost "${cost.name}".`,
            };
            throw new ApiError(400, validationError.message, [validationError]);
            }
            // Validate that the account type matches the payment method
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

    // Add validation for productInfo.quantityUnit
    if (lcData.productInfo && Array.isArray(lcData.productInfo)) { // Fixed Array.isArray typo
      for (const product of lcData.productInfo) {
        if (product.quantityUnit) {
          // If product.quantityUnit is an object, extract the ID
          if (typeof product.quantityUnit === "object" && product.quantityUnit.id) {
            product.quantityUnit = product.quantityUnit.id;
          }
          const existingUnit = await Unit.findById(product.quantityUnit).session(session); // Ensure session is used
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

    await lc.save({ session }); // Save LC within the session

    if (req.files && req.files.length > 0) {
      const newLcDir = path.join(uploadDir, lc._id.toString());
      await ensureDir(newLcDir);

      for (const file of req.files) {
        const oldPath = file.path;
        const newPath = path.join(newLcDir, file.filename);
        await fs.rename(oldPath, newPath);
      }
    }

    // After LC is saved, create transactions for costs
    for (const section of sectionsWithCosts) {
      if (lcData[section] && lcData[section].costs) {
        for (const cost of lcData[section].costs) {
          if (cost.accountId && cost.amount > 0) { // Only create transaction if accountId is present and amount > 0
            // DailyCash Gatekeeper Check
            const costDateNormalized = new Date(cost.date);
            costDateNormalized.setHours(0, 0, 0, 0);
            const dailyCash = await DailyCash.findOne({ date: costDateNormalized }).session(session);

            if (!dailyCash || dailyCash.status === "Closed") {
              throw new ApiError(
                400,
                `Daily cash is closed for ${costDateNormalized.toDateString()}. Cannot record LC cost transaction.`
              );
            }

            const account = await Account.findById(cost.accountId).session(session);
            if (!account) {
                throw new ApiError(404, `Account with ID ${cost.accountId} not found for cost ${cost.name}.`);
            }
            if (account.balance < cost.amount) {
                throw new ApiError(400, `Insufficient balance in ${account.accountName} (${account.accountType}) account for cost ${cost.name}.`);
            }

            // Decrease account balance
            account.balance -= cost.amount;
            await account.save({ session });

            // Create Transaction for LC cost
            await Transaction.create([{
                accountId: cost.accountId,
                date: cost.date,
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

    if (error instanceof ApiError) {
      // Cleanup uploaded files if an ApiError is thrown after they are created
      if (req.files) {
        for (const file of req.files) {
          try {
            await fs.unlink(file.path);
          } catch (unlinkError) {
            console.error(
              `Failed to delete temporary file on ApiError: ${file.path}`,
              unlinkError
            );
          }
        }
      }
      return next(error);
    }

    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(new ApiError(409, `An LC with the same ${field} '${value}' already exists.`)); // Specific message for LC
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
    next(new ApiError(500, error.message || "Something went wrong"));
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

    const openSession = await DailyCash.findOne({ date: costDateNormalized, status: "Open" }).session(session);
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
    if (!lc) return next(new ApiError(404, "LC not found"));
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
  try {
    const { id } = req.params;
    const lc = await LC.findById(id);

    if (!lc) {
      return next(new ApiError(404, "LC not found"));
    }

    // Update fields from req.body
    Object.assign(lc, req.body);

    const updated = await lc.save(); // This will trigger the pre-save hook

    return res
      .status(200)
      .json(new ApiResponse(200, updated, "LC updated successfully"));
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

async function deleteLC(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const deletedLC = await LC.findByIdAndDelete(id, { session }); // Use session here

    if (!deletedLC) {
      throw new ApiError(404, "LC not found");
    }

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
    const lcs = await LC.find({ "basicInfo.status": /^Completed$/i })
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
    if (error instanceof ApiError) {
      return next(error);
    }
    if (error.code === 'ENOENT') {
      return next(new ApiError(404, "File not found"));
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

async function exportLCAsPDF(req, res, next) {
  try {
    const { id } = req.params;
    const lc = await LC.findById(id);

    if (!lc) {
      return next(new ApiError(404, "LC not found"));
    }

    generateLCPDF(lc, res);

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
async function getActiveLcs(req,res,next){
  try {
    const lcs = await LC.find({ "basicInfo.status": /^Active$/i })
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
    const filter = {};
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
    const filter = {};
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
};
