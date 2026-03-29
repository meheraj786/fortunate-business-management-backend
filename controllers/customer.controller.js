const Customer = require("../models/customer.model");
const Sales = require("../models/sales.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const logger = require("../utils/logger");
const { now } = require("../utils/timezone.util");
const mongoose = require("mongoose");
const Trash = require("../models/trash.model");
const path = require("path");
const multer = require("multer");
const storageUtil = require("../utils/storage.util.js");
const Account = require("../models/account.model");
const DailyCash = require("../models/dailyCash.model");
const Transaction = require("../models/transaction.model");
const CreditHistory = require("../models/creditHistory.model");
const mathUtil = require("../utils/math.util");
const { startOfDay } = require("../utils/timezone.util");
const { formatAccountLabel } = require("../utils/format.util");
const Counter = require("../models/counter.model");
const auditService = require("../services/audit.service");
const { escapeRegex } = require("../utils/regex.util");

// --- Multer Configuration ---
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, storageUtil.TEMP_DIR);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = path.parse(file.originalname).name + "-" + Date.now();
    const extension = path.extname(file.originalname);
    cb(null, `${uniqueSuffix}${extension}`);
  },
});

const ALLOWED_MIME_TYPES = [
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB per file
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) return cb(null, true);
    cb(new ApiError(400, `File type '${file.mimetype}' is not allowed. Accepted: images, PDF, Word, Excel.`));
  },
});

async function createCustomer(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  const uploadedFiles = req.files || [];
  try {
    const customerData = JSON.parse(req.body.customerData);

    const currentYear = new Date().getFullYear();
    const counterId = `customerId_${currentYear}`;

    // 1. Atomically increment the counter
    let counter = await Counter.findByIdAndUpdate(
      counterId,
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    ).session(session);

    // 2. SELF-HEALING / INITIALIZATION CHECK
    if (counter.seq === 1) {
      const lastCustomer = await Customer.findOne({
        customerId: new RegExp(`^CUST-${currentYear}-`, "i"),
      }).sort({ customerId: -1 }).session(session);

      let maxLegacyId = 0;
      if (lastCustomer && lastCustomer.customerId) {
        const match = lastCustomer.customerId.match(/(\d+)$/);
        if (match) {
          maxLegacyId = parseInt(match[1], 10);
        }
      }

      if (maxLegacyId >= 1) {
        counter = await Counter.findByIdAndUpdate(
          counterId,
          { $set: { seq: maxLegacyId + 1 } },
          { new: true, session }
        );
      }
    }

    const newCustomerId = `CUST-${currentYear}-${counter.seq
      .toString()
      .padStart(4, "0")}`;

    customerData.customerId = newCustomerId;
    customerData.createdBy = req.user?._id || null;

    // 1. Prepare document metadata
    const preparedDocs = uploadedFiles.map((file) =>
      storageUtil.prepareDocumentData(file),
    );
    customerData.documents = preparedDocs.map((p) => p.docData);

    const [customer] = await Customer.create([customerData], { session });

    // Handle Opening Due
    const { openingDue } = customerData;
    if (openingDue && openingDue > 0) {
      const openingBalanceSaleId = `OPEN-BAL-${customer.customerId.toString()}`;

      const openingBalanceSale = {
        saleId: openingBalanceSaleId,
        customer: {
          customerId: customer._id,
          name: customer.name,
          phone: customer.phone,
          address: customer.billingAddress,
        },
        category: null,
        costs: [],
        charges: [],
        discount: 0,
        invoiceStatus: "Invoiced",
        paymentStatus: "Due payment",
        payments: [],
        notes: `Automated entry for customer's opening due balance: ${openingDue}.`,
        saleDate: customer.joinDate || now(),
        totalAmount: openingDue,
        totalAmountToBePaid: openingDue,
        balanceDue: openingDue,
      };

      await Sales.create([openingBalanceSale], { session });
    }

    await session.commitTransaction();
    session.endSession();

    // Commit files AFTER DB transaction succeeds — prevents orphaned files on rollback
    for (const preparedDoc of preparedDocs) {
      try {
        await storageUtil.commitCustomerDocument(
          preparedDoc.tempPath,
          preparedDoc.docData,
          customer.customerId,
        );
      } catch (fileErr) {
        logger.error(`Failed to commit file post-transaction: ${preparedDoc.docData.originalName}`, fileErr);
      }
    }

    // Audit: Customer created
    auditService.log({ action: "CREATE", module: "Customer", documentId: customer._id, displayId: customer.customerId, userId: req.user?._id, description: `Created customer ${customer.name} (${customer.customerId})`, req });

    return res
      .status(201)
      .json(new ApiResponse(201, customer, "Customer created successfully"));
  } catch (error) {
    await session.abortTransaction();
    session.endSession();

    // On error, cleanup temp files
    await storageUtil.cleanupTempFiles(uploadedFiles);

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
          `A customer with the same ${field} '${value}' already exists.`,
        ),
      );
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
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
}

async function getAllActiveCustomers(_, res, next) {
  try {
    const customers = await Customer.find({ isDeleted: false })
      .select("_id name customerId phone creditBalance")
      .lean();

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          customers,
          "Active customers fetched successfully",
        ),
      );
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
}

async function getCustomerById(req, res, next) {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ApiError(400, "Invalid customer ID"));
    }

    const pipeline = [
      { $match: { _id: new mongoose.Types.ObjectId(id) } },
      {
        $lookup: {
          from: "users",
          localField: "createdBy",
          foreignField: "_id",
          as: "creator",
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "modifiedBy",
          foreignField: "_id",
          as: "modifier",
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "deletedBy",
          foreignField: "_id",
          as: "deleter",
        },
      },
      {
        $addFields: {
          createdBy: { $arrayElemAt: ["$creator", 0] },
          modifiedBy: { $arrayElemAt: ["$modifier", 0] },
          deletedBy: { $arrayElemAt: ["$deleter", 0] },
        },
      },
      {
        $project: {
          creator: 0,
          modifier: 0,
          deleter: 0,
          "createdBy.password": 0,
          "modifiedBy.password": 0,
          "deletedBy.password": 0,
        },
      },
      // Optimized: compute customer stats inside the $lookup sub-pipeline
      // instead of loading all sales documents into the parent pipeline
      {
        $lookup: {
          from: "sales",
          let: { customerId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$customer.customerId", "$$customerId"] },
                    { $ne: ["$isDeleted", true] },
                  ],
                },
              },
            },
            {
              $group: {
                _id: null,
                totalPurchases: { $sum: 1 },
                totalSpent: { $sum: "$totalAmountToBePaid" },
                notInvoiced: {
                  $sum: { $cond: [{ $eq: ["$invoiceStatus", "Not-invoiced"] }, 1, 0] },
                },
                outstandingDues: {
                  $sum: {
                    $cond: [
                      { $eq: ["$paymentStatus", "Due payment"] },
                      { $subtract: ["$totalAmountToBePaid", { $ifNull: ["$totalPaid", 0] }] },
                      0,
                    ],
                  },
                },
              },
            },
          ],
          as: "salesStats",
        },
      },
      {
        $addFields: {
          stats: {
            $let: {
              vars: { s: { $arrayElemAt: ["$salesStats", 0] } },
              in: {
                totalPurchases: { $ifNull: ["$$s.totalPurchases", 0] },
                totalSpent: { $ifNull: ["$$s.totalSpent", 0] },
                notInvoiced: { $ifNull: ["$$s.notInvoiced", 0] },
                outstandingDues: { $ifNull: ["$$s.outstandingDues", 0] },
              },
            },
          },
        },
      },
      {
        $project: {
          salesStats: 0,
        },
      },
    ];

    const results = await Customer.aggregate(pipeline);

    if (results.length === 0) {
      return next(new ApiError(404, "Customer not found"));
    }

    const customerData = results[0];

    return res
      .status(200)
      .json(
        new ApiResponse(200, customerData, "Customer fetched successfully"),
      );
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A customer with the same ${field} '${value}' already exists.`,
        ),
      );
    }
    if (error.name === "ValidationError") {
      const firstErrorField = Object.keys(error.errors)[0];
      let userFriendlyMessage = "Validation failed.";

      if (firstErrorField) {
        userFriendlyMessage = `The field ${firstErrorField} is required.`;
      }
      return next(new ApiError(400, userFriendlyMessage, error.errors));
    }
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
}

async function updateCustomer(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  const uploadedFiles = req.files || [];
  let preparedNewDocs = [];
  try {
    const { id } = req.params;
    const updateData = JSON.parse(req.body.customerData);
    const { openingDue, ...customerUpdateData } = updateData;

    const customer = await Customer.findById(id).session(session);
    if (!customer) {
      throw new ApiError(404, "Customer not found");
    }

    const newOpeningDue =
      openingDue !== undefined && !isNaN(parseFloat(openingDue))
        ? parseFloat(openingDue)
        : null;

    if (newOpeningDue !== null) {
      const openingBalanceSaleId = `OPEN-BAL-${customer.customerId}`;
      const existingOpeningSale = await Sales.findOne({
        saleId: openingBalanceSaleId,
      }).session(session);

      if (existingOpeningSale) {
        if (existingOpeningSale.totalAmountToBePaid !== newOpeningDue) {
          existingOpeningSale.totalAmount = newOpeningDue;
          existingOpeningSale.totalAmountToBePaid = newOpeningDue;
          existingOpeningSale.balanceDue = newOpeningDue;
          await existingOpeningSale.save({ session });
        }
      } else if (newOpeningDue > 0) {
        const openingBalanceSale = {
          saleId: openingBalanceSaleId,
          customer: {
            customerId: customer._id,
            name: customer.name,
            phone: customer.phone,
            address: customer.billingAddress,
          },
          category: null,
          costs: [],
          charges: [],
          discount: 0,
          invoiceStatus: "Invoiced",
          paymentStatus: "Due payment",
          payments: [],
          notes: `Automated entry for customer's opening due balance (updated): ${newOpeningDue}.`,
          saleDate: customer.joinDate || now(),
          totalAmount: newOpeningDue,
          totalAmountToBePaid: newOpeningDue,
          balanceDue: newOpeningDue,
        };
        await Sales.create([openingBalanceSale], { session });
      }
      customerUpdateData.openingDue = newOpeningDue;
    }

    // --- Document Management ---
    const existingDocs = customer.documents || [];
    const incomingDocs = customerUpdateData.documents || [];
    let finalDocs = [];

    const docsToDelete = existingDocs.filter(
      (doc) =>
        !incomingDocs.some(
          (inDoc) => inDoc._id && inDoc._id.toString() === doc._id.toString(),
        ),
    );

    for (const doc of docsToDelete) {
      await storageUtil.deleteCustomerDocument(
        customer.customerId,
        doc.path,
        doc.storedName,
      );
      storageUtil.cleanupEmptyCustomerDirectory(customer.customerId, doc.path);
    }

    finalDocs = existingDocs.filter((doc) =>
      incomingDocs.some(
        (inDoc) => inDoc._id && inDoc._id.toString() === doc._id.toString(),
      ),
    );

    if (uploadedFiles.length > 0) {
      preparedNewDocs = uploadedFiles.map((file) =>
        storageUtil.prepareDocumentData(file),
      );
      finalDocs.push(...preparedNewDocs.map((p) => p.docData));
    }

    customerUpdateData.documents = finalDocs;

    // Capture snapshot for audit diff (before mutation)
    const customerSnapshot = customer.toObject();

    // Update customer document with new data
    customerUpdateData.modifiedBy = req.user?._id || null;
    Object.assign(customer, customerUpdateData);
    const updatedCustomer = await customer.save({ session });

    if (preparedNewDocs.length > 0) {
      for (const preparedDoc of preparedNewDocs) {
        await storageUtil.commitCustomerDocument(
          preparedDoc.tempPath,
          preparedDoc.docData,
          customer.customerId,
        );
      }
    }

    await session.commitTransaction();
    session.endSession();

    // Audit: Customer updated
    auditService.log({ action: "UPDATE", module: "Customer", documentId: updatedCustomer._id, displayId: updatedCustomer.customerId, userId: req.user?._id, description: `Updated customer ${updatedCustomer.name} (${updatedCustomer.customerId})`, changes: auditService.diffChanges(customerSnapshot, updatedCustomer, ["name", "phone", "email", "billingAddress", "creditLimit", "customerStatus", "customerType", "location"]), req });

    return res
      .status(200)
      .json(
        new ApiResponse(200, updatedCustomer, "Customer updated successfully"),
      );
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    await storageUtil.cleanupTempFiles(uploadedFiles);
    if (error instanceof ApiError) {
      return next(error);
    }
    if (error.code === 11000) {
      return next(
        new ApiError(
          409,
          "A customer with the same phone number already exists.",
        ),
      );
    }
    if (error.name === "ValidationError") {
      return next(new ApiError(400, "Validation failed.", error.errors));
    }
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
}
async function deleteCustomer(req, res, next) {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ApiError(400, "Invalid customer ID"));
    }

    const sales = await Sales.find({
      "customer.customerId": new mongoose.Types.ObjectId(id),
      isDeleted: false,
    }).lean();

    let outstandingDues = 0;
    sales.forEach((sale) => {
      const totalPaid = sale.payments.reduce((acc, p) => acc + p.amount, 0);
      const due = sale.totalAmountToBePaid - totalPaid;
      if (due > 0) {
        outstandingDues += due;
      }
    });

    if (outstandingDues > 0) {
      return next(
        new ApiError(
          400,
          `Cannot delete customer with outstanding dues of ${outstandingDues}.`,
        ),
      );
    }

    const deleted = await Customer.findByIdAndUpdate(id, {
      isDeleted: true,
      deletedBy: req.user?._id || null,
    });

    if (!deleted) {
      return next(new ApiError(404, "Customer not found"));
    }

    await Trash.create({
      docId: deleted._id,
      model: "Customer",
      deletedBy: req.user?._id || null,
      deletedAt: now(),
    });

    // Audit: Customer deleted
    auditService.log({ action: "DELETE", module: "Customer", documentId: deleted._id, displayId: deleted.customerId, userId: req.user?._id, description: `Deleted customer ${deleted.name} (${deleted.customerId})`, req });

    return res
      .status(200)
      .json(
        new ApiResponse(200, deleted, "Customer moved to trash successfully"),
      );
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A customer with the same ${field} '${value}' already exists.`,
        ),
      );
    }
    if (error.name === "ValidationError") {
      const firstErrorField = Object.keys(error.errors)[0];
      let userFriendlyMessage = "Validation failed.";

      if (firstErrorField) {
        userFriendlyMessage = `The field ${firstErrorField} is required.`;
      }
      return next(new ApiError(400, userFriendlyMessage, error.errors));
    }
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
}
// Other functions remain unchanged

async function downloadCustomerDocument(req, res, next) {
  try {
    const { id, docId } = req.params;

    const customer = await Customer.findById(id);
    if (!customer || customer.isDeleted) {
      throw new ApiError(404, "Customer not found");
    }

    const doc = customer.documents.id(docId);
    if (!doc) {
      throw new ApiError(404, "Document not found in this customer record");
    }

    const filePath = path.join(
      storageUtil.CUSTOMER_DOCUMENTS_DIR,
      doc.path,
      customer.customerId,
      doc.storedName,
    );

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
    next(error);
  }
}

async function deleteCustomerDocument(req, res, next) {
  const { id, docId } = req.params;
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const customer = await Customer.findById(id).session(session);
    if (!customer) {
      throw new ApiError(404, "Customer not found");
    }

    const doc = customer.documents.id(docId);
    if (!doc) {
      throw new ApiError(404, "Document not found in this customer record");
    }

    await storageUtil.deleteCustomerDocument(
      customer.customerId,
      doc.path,
      doc.storedName,
    );

    customer.documents.pull(docId);
    await customer.save({ session });

    await session.commitTransaction();
    session.endSession();

    storageUtil.cleanupEmptyCustomerDirectory(customer.customerId, doc.path);

    return res
      .status(200)
      .json(new ApiResponse(200, customer, "Document deleted successfully."));
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    next(error);
  }
}

async function getCustomersSummary(req, res, next) {
  try {
    const {
      page = 1,
      limit = 10,
      search,
      status,
      customerType,
      sortBy,
      sortOrder = "desc",
    } = req.query;

    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;
    const sortOrderNum = sortOrder === "asc" ? 1 : -1;

    // --- Aggregation Pipeline ---
    const pipeline = [];

    // Stage 1: Initial Filtering & Searching
    const matchConditions = { isDeleted: { $ne: true } };
    if (status) {
      matchConditions.customerStatus = status;
    }
    if (customerType) {
      matchConditions.customerType = customerType;
    }
    if (search) {
      const searchRegex = { $regex: escapeRegex(search), $options: "i" };
      matchConditions.$or = [
        { name: searchRegex },
        { phone: searchRegex },
        { customerId: searchRegex },
      ];
    }
    if (Object.keys(matchConditions).length > 0) {
      pipeline.push({ $match: matchConditions });
    }

    // Stage 2: Lookup to join with Sales
    pipeline.push({
      $lookup: {
        from: "sales",
        let: { customerId: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$customer.customerId", "$$customerId"] },
                  { $ne: ["$isDeleted", true] },
                ],
              },
            },
          },
        ],
        as: "sales",
      },
    });

    // Stage 3: Add fields to calculate summary stats
    pipeline.push({
      $addFields: {
        totalPurchases: { $size: "$sales" },
        totalSpent: { $sum: "$sales.totalAmountToBePaid" },
        lastPurchaseDate: { $max: "$sales.saleDate" },
        totalNotInvoiced: {
          $sum: {
            $map: {
              input: "$sales",
              as: "sale",
              in: {
                $cond: [
                  { $eq: ["$$sale.invoiceStatus", "Not-invoiced"] },
                  1,
                  0,
                ],
              },
            },
          },
        },
        totalDue: {
          $sum: {
            $map: {
              input: {
                $filter: {
                  input: "$sales",
                  as: "sale",
                  cond: { $eq: ["$$sale.paymentStatus", "Due payment"] },
                },
              },
              as: "dueSale",
              in: {
                $subtract: [
                  "$$dueSale.totalAmountToBePaid",
                  { $sum: "$$dueSale.payments.amount" },
                ],
              },
            },
          },
        },
      },
    });

    // Stage 4: Sorting
    const sortStage = {};
    const validSortBy = [
      "name",
      "creditLimit",
      "joinDate",
      "totalPurchases",
      "totalSpent",
      "totalDue",
      "totalNotInvoiced",
      "lastPurchaseDate",
    ];
    if (validSortBy.includes(sortBy)) {
      sortStage[sortBy] = sortOrderNum;
    } else {
      sortStage.name = 1; // Default sort
    }

    // Stage 5: Facet for pagination and total count
    pipeline.push({
      $facet: {
        customers: [
          { $sort: sortStage },
          { $skip: skip },
          { $limit: limitNum },
          {
            $project: {
              sales: 0, // Exclude the full sales array
            },
          },
        ],
        metadata: [{ $count: "totalItems" }],
      },
    });

    const result = await Customer.aggregate(pipeline);

    const customersSummary = result[0].customers;
    const totalCustomers =
      result[0].metadata.length > 0 ? result[0].metadata[0].totalItems : 0;

    return res.status(200).json(
      new ApiResponse(
        200,
        {
          customers: customersSummary,
          totalPages: Math.ceil(totalCustomers / limitNum),
          currentPage: pageNum,
          totalItems: totalCustomers,
        },
        "Customers summary fetched successfully",
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
          `A customer with the same ${field} '${value}' already exists.`,
        ),
      );
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
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
}

async function getDueCustomers(req, res, next) {
  try {
    const {
      page = 1,
      limit = 10,
      search,
      sortBy,
      sortOrder = "desc",
      dateFrom,
      dateTo,
    } = req.query;

    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;
    const sortOrderNum = sortOrder === "asc" ? 1 : -1;

    const pipeline = [];

    // Stage 1: Only active customers
    const matchConditions = { isDeleted: { $ne: true } };
    if (search) {
      const searchRegex = { $regex: escapeRegex(search), $options: "i" };
      matchConditions.$or = [
        { name: searchRegex },
        { phone: searchRegex },
        { customerId: searchRegex },
      ];
    }
    pipeline.push({ $match: matchConditions });

    // Build sales sub-pipeline match conditions
    const salesMatchConditions = [
      { $eq: ["$customer.customerId", "$$customerId"] },
      { $ne: ["$isDeleted", true] },
    ];

    // Add date range filter on saleDate
    if (dateFrom) {
      salesMatchConditions.push({
        $gte: ["$saleDate", new Date(dateFrom)],
      });
    }
    if (dateTo) {
      // dateTo is end of day
      const endDate = new Date(dateTo);
      endDate.setHours(23, 59, 59, 999);
      salesMatchConditions.push({
        $lte: ["$saleDate", endDate],
      });
    }

    // Stage 2: Lookup sales with optional date filtering
    pipeline.push({
      $lookup: {
        from: "sales",
        let: { customerId: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: salesMatchConditions,
              },
            },
          },
        ],
        as: "sales",
      },
    });

    // Stage 3: Calculate summary fields
    pipeline.push({
      $addFields: {
        totalPurchases: { $size: "$sales" },
        totalSpent: { $sum: "$sales.totalAmountToBePaid" },
        lastPurchaseDate: { $max: "$sales.saleDate" },
        dueSalesCount: {
          $size: {
            $filter: {
              input: "$sales",
              as: "sale",
              cond: { $eq: ["$$sale.paymentStatus", "Due payment"] },
            },
          },
        },
        totalDue: {
          $sum: {
            $map: {
              input: {
                $filter: {
                  input: "$sales",
                  as: "sale",
                  cond: { $eq: ["$$sale.paymentStatus", "Due payment"] },
                },
              },
              as: "dueSale",
              in: {
                $subtract: [
                  "$$dueSale.totalAmountToBePaid",
                  { $sum: "$$dueSale.payments.amount" },
                ],
              },
            },
          },
        },
      },
    });

    // Stage 3b: Calculate totalPaid (derived from totalSpent - totalDue)
    pipeline.push({
      $addFields: {
        totalPaid: { $subtract: ["$totalSpent", "$totalDue"] },
      },
    });

    // Stage 4: Filter only customers with dues > 0
    pipeline.push({
      $match: { totalDue: { $gt: 0 } },
    });

    // Stage 5: Sorting
    const sortStage = {};
    const validSortBy = [
      "totalDue",
      "name",
      "totalSpent",
      "totalPurchases",
      "dueSalesCount",
      "totalPaid",
      "lastPurchaseDate",
      "joinDate",
    ];
    if (validSortBy.includes(sortBy)) {
      sortStage[sortBy] = sortOrderNum;
    } else {
      sortStage.totalDue = -1; // Default: highest due first
    }

    // Stage 6: Facet for pagination, total count, and grand total
    pipeline.push({
      $facet: {
        customers: [
          { $sort: sortStage },
          { $skip: skip },
          { $limit: limitNum },
          {
            $project: {
              sales: 0,
            },
          },
        ],
        metadata: [
          {
            $group: {
              _id: null,
              totalItems: { $sum: 1 },
              totalDueAmount: { $sum: "$totalDue" },
            },
          },
        ],
      },
    });

    const result = await Customer.aggregate(pipeline);

    const customers = result[0].customers;
    const meta = result[0].metadata.length > 0 ? result[0].metadata[0] : { totalItems: 0, totalDueAmount: 0 };

    return res.status(200).json(
      new ApiResponse(
        200,
        {
          customers,
          totalPages: Math.ceil(meta.totalItems / limitNum),
          currentPage: pageNum,
          totalItems: meta.totalItems,
          totalDueAmount: meta.totalDueAmount,
        },
        "Due customers fetched successfully",
      ),
    );
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
}

module.exports = {
  createCustomer,
  getCustomerById,
  updateCustomer,
  deleteCustomer,
  getCustomersSummary,
  getDueCustomers,
  getAllActiveCustomers,
  downloadCustomerDocument,
  deleteCustomerDocument,
  addStoreCredit,
  withdrawStoreCredit,
  getCreditHistory,
  upload,
};

async function addStoreCredit(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const { amount, paymentMethod, accountId, date } = req.body;

    // Validation
    if (!amount || amount <= 0)
      throw new ApiError(400, "Valid amount is required");
    if (!paymentMethod) throw new ApiError(400, "Payment method is required");
    if (!accountId) throw new ApiError(400, "Account is required");

    const customer = await Customer.findById(id).session(session);
    if (!customer) throw new ApiError(404, "Customer not found");

    // 1. Account & DailyCash Logic (Real Money In)
    const account = await Account.findById(accountId).session(session);
    if (!account) throw new ApiError(404, "Account not found");

    if (
      account.accountType !==
      (paymentMethod === "Mobile Banking" ? "Mobile Banking" : paymentMethod)
    ) {
      throw new ApiError(
        400,
        `Account type mismatch. Expected ${paymentMethod}`,
      );
    }

    const txDate = date ? new Date(date) : now();
    const paymentDateNormalized = startOfDay(txDate, req.businessTimezone);
    const dailyCash = await DailyCash.findOne({
      date: paymentDateNormalized,
    })
      .sort({ createdAt: -1 })
      .session(session);

    if (!dailyCash || dailyCash.status === "Closed") {
      throw new ApiError(
        400,
        `Daily cash is closed for ${paymentDateNormalized.toDateString()}.`,
      );
    }

    account.balance = mathUtil.add(account.balance, Number(amount));
    await account.save({ session });

    // 2. Transaction Record
    await Transaction.create(
      [
        {
          accountId,
          date: txDate,
          transactionType: "Income",
          amount,
          name: "Store Credit Deposit",
          source: "Manual",
          category: "Customer Credit",
          paymentMethod,
          reference: customer._id,
          referenceModel: "Customer",
          description: `Store Credit deposit from ${customer.name} (${customer.phone
            }) via ${paymentMethod} Account: ${formatAccountLabel(account)}`,
          createdBy: req.user?._id,
        },
      ],
      { session },
    );

    // 3. Update Customer Credit
    customer.creditBalance = mathUtil.add(customer.creditBalance || 0, Number(amount));
    await customer.save({ session });

    // 4. Credit History Record
    await CreditHistory.create(
      [
        {
          customer: customer._id,
          amount,
          type: "Credit",
          reason: "Manual Deposit",
          description: `Manual deposit via ${paymentMethod} Account: ${formatAccountLabel(
            account,
          )}`,
          createdBy: req.user?._id,
        },
      ],
      { session },
    );

    await session.commitTransaction();
    session.endSession();

    // Audit: Store credit added
    auditService.log({ action: "PAYMENT", module: "Customer", documentId: customer._id, displayId: customer.customerId, userId: req.user?._id, description: `Added store credit of ${amount} to ${customer.name} via ${paymentMethod}`, metadata: { amount, paymentMethod, accountId }, req });

    return res
      .status(200)
      .json(new ApiResponse(200, customer, "Credit added successfully"));
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    next(error);
  }
}

async function withdrawStoreCredit(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const { amount, paymentMethod, accountId, date, reason } = req.body;

    // Validation
    const parsedAmount = Number(amount);
    if (!parsedAmount || parsedAmount <= 0)
      throw new ApiError(400, "Valid amount is required");
    if (!paymentMethod) throw new ApiError(400, "Payment method is required");
    if (!accountId) throw new ApiError(400, "Account is required");

    const customer = await Customer.findById(id).session(session);
    if (!customer) throw new ApiError(404, "Customer not found");

    // Check sufficient credit balance
    if ((customer.creditBalance || 0) < parsedAmount) {
      throw new ApiError(
        400,
        `Insufficient credit balance. Available: ${customer.creditBalance || 0}, Requested: ${parsedAmount}`,
      );
    }

    // 1. Account & DailyCash Logic (Real Money Out — refund to customer)
    const account = await Account.findById(accountId).session(session);
    if (!account) throw new ApiError(404, "Account not found");

    if (
      account.accountType !==
      (paymentMethod === "Mobile Banking" ? "Mobile Banking" : paymentMethod)
    ) {
      throw new ApiError(
        400,
        `Account type mismatch. Expected ${paymentMethod}`,
      );
    }

    // Check account has sufficient balance
    if (account.balance < parsedAmount) {
      throw new ApiError(
        400,
        `Insufficient account balance. Available: ${account.balance}, Requested: ${parsedAmount}`,
      );
    }

    const txDate = date ? new Date(date) : now();
    const paymentDateNormalized = startOfDay(txDate, req.businessTimezone);
    const dailyCash = await DailyCash.findOne({
      date: paymentDateNormalized,
    })
      .sort({ createdAt: -1 })
      .session(session);

    if (!dailyCash || dailyCash.status === "Closed") {
      throw new ApiError(
        400,
        `Daily cash is closed for ${paymentDateNormalized.toDateString()}.`,
      );
    }

    // Deduct from account (money goes out)
    account.balance = mathUtil.sub(account.balance, parsedAmount);
    await account.save({ session });

    // 2. Transaction Record (Expense — money leaving the business)
    const [transaction] = await Transaction.create(
      [
        {
          accountId,
          date: txDate,
          transactionType: "Expense",
          amount: parsedAmount,
          name: "Credit Withdrawal / Refund",
          source: "Manual",
          category: "Customer Credit",
          paymentMethod,
          reference: customer._id,
          referenceModel: "Customer",
          description: `Credit withdrawal/refund to ${customer.name} (${customer.customerId}) via ${paymentMethod} Account: ${formatAccountLabel(account)}${reason ? `. Reason: ${reason}` : ""}`,
          createdBy: req.user?._id,
        },
      ],
      { session },
    );

    // 3. Update Customer Credit Balance
    customer.creditBalance = mathUtil.sub(customer.creditBalance || 0, parsedAmount);
    await customer.save({ session });

    // 4. Credit History Record
    await CreditHistory.create(
      [
        {
          customer: customer._id,
          amount: parsedAmount,
          type: "Debit",
          reason: "Withdrawal",
          reference: transaction._id,
          referenceModel: "Transaction",
          description: `Withdrawal/Refund via ${paymentMethod} Account: ${formatAccountLabel(account)}${reason ? `. Reason: ${reason}` : ""}`,
          createdBy: req.user?._id,
        },
      ],
      { session },
    );

    await session.commitTransaction();
    session.endSession();

    // Audit: Credit withdrawal
    auditService.log({ action: "PAYMENT", module: "Customer", documentId: customer._id, displayId: customer.customerId, userId: req.user?._id, description: `Withdrew/Refunded credit of ${parsedAmount} from ${customer.name} via ${paymentMethod}`, metadata: { amount: parsedAmount, paymentMethod, accountId, reason }, req });

    return res
      .status(200)
      .json(new ApiResponse(200, customer, "Credit withdrawn successfully"));
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    next(error);
  }
}

async function getCreditHistory(req, res, next) {
  try {
    const { id } = req.params;
    const { page = 1, limit = 10, type, startDate, endDate, search } = req.query;

    const query = { customer: id };

    if (type && type !== "All") {
      query.type = type;
    }

    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        query.date.$lte = end;
      }
    }

    if (search && search.trim() !== "") {
      const regex = new RegExp(search.trim(), "i");
      query.$or = [{ reason: regex }, { description: regex }];
    }

    const history = await CreditHistory.find(query)
      .sort({ date: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate("createdBy", "name")
      .populate("reference") // Populate Sale or Transaction if needed
      .lean();

    const total = await CreditHistory.countDocuments(query);

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          { history, total, page: parseInt(page), limit: parseInt(limit) },
          "Credit history fetched",
        ),
      );
  } catch (error) {
    next(error);
  }
}
