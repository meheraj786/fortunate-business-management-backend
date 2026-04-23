const Sales = require("../models/sales.model");
const Customer = require("../models/customer.model");
const Invoice = require("../models/invoice.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const logger = require("../utils/logger");
const mongoose = require("mongoose");
const auditService = require("../services/audit.service");

// --- Shared error handler for invoice operations ---
function handleInvoiceError(error, next) {
  if (error instanceof ApiError) {
    return next(error);
  }
  if (error.code === 11000 && error.keyPattern && error.keyValue) {
    const field = Object.keys(error.keyPattern)[0];
    const value = error.keyValue[field];
    return next(
      new ApiError(
        409,
        `An invoice with the same ${field} '${value}' already exists.`,
      ),
    );
  }
  if (error.name === "ValidationError") {
    const firstErrorField = Object.keys(error.errors)[0];
    const msg = firstErrorField
      ? `The field ${firstErrorField} is required.`
      : "Validation failed.";
    return next(new ApiError(400, msg, error.errors));
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

async function generateInvoice(req, res, next) {
  try {
    const { saleId } = req.body;

    if (!saleId) {
      const validationError = {
        field: "saleId",
        message: "Sale ID is required",
      };
      return next(
        new ApiError(400, validationError.message, [validationError]),
      );
    }

    const sale = await Sales.findById(saleId)
      .populate("items.unit")
      .populate({ path: "category", strictPopulate: false })
      .populate({
        path: "items.product",
        strictPopulate: false,
        populate: {
          path: "category",
          select: "name",
        },
      });

    if (!sale) {
      return next(new ApiError(404, "Sale not found"));
    }

    if (sale.invoiceStatus !== "Invoiced") {
      return next(
        new ApiError(400, "Invoice can only be generated for confirmed sales."),
      );
    }

    // Find the most recent invoice for this sale to check for changes.
    const latestInvoice = await Invoice.findOne({ salesId: sale.saleId }).sort({
      createdAt: -1,
    });

    // If an invoice already exists, check if there have been meaningful changes.
    if (latestInvoice) {
      const areFinancialArraysEqual = (arrA, arrB) => {
        if (arrA.length !== arrB.length) return false;

        const sortAndStringify = (arr) =>
          arr
            .map(({ amount, name, method, date, accountId }) =>
              JSON.stringify({
                amount,
                name,
                method,
                date: date?.toString(),
                accountId: accountId?.toString(),
              }),
            )
            .sort()
            .join(",");

        return sortAndStringify(arrA) === sortAndStringify(arrB);
      };

      // Filter out reversed payments for comparison — reversed payments are
      // kept in the sale for audit, but should not appear on new invoices
      const activePayments = sale.payments.filter(p => !p.isReversed);

      if (
        areFinancialArraysEqual(
          activePayments,
          latestInvoice.paymentAndAmountInfo.payments,
        ) &&
        areFinancialArraysEqual(
          sale.costs,
          latestInvoice.paymentAndAmountInfo.costs,
        ) &&
        areFinancialArraysEqual(
          sale.charges,
          latestInvoice.paymentAndAmountInfo.charges,
        )
      ) {
        return next(new ApiError(400, "no new changes made in the sale"));
      }
    }

    const currentYear = new Date().getFullYear();
    const shortYear = currentYear.toString().slice(-2);

    const lastInvoice = await Invoice.findOne({
      invoiceId: new RegExp(`^INV-${shortYear}-`, "i"),
    }).sort({ invoiceId: -1 });

    let lastInvoiceNumber = 0;
    if (lastInvoice && lastInvoice.invoiceId) {
      const match = lastInvoice.invoiceId.match(/(\d+)$/);
      if (match) {
        lastInvoiceNumber = parseInt(match[1], 10);
      }
    }

    const newInvoiceId = `INV-${shortYear}-${(lastInvoiceNumber + 1)
      .toString()
      .padStart(6, "0")}`;

    let customerDetails = {
      name: sale.customer.name,
      phone: sale.customer.phone,
      address: sale.customer.address,
      customerId: null,
    };

    if (sale.customer.customerId) {
      const customer = await Customer.findById(sale.customer.customerId);
      if (customer) {
        customerDetails = {
          name: customer.name,
          phone: customer.phone,
          address: customer.location,
          customerId: customer._id,
        };
      }
    }

    const paymentsArray = sale.payments || [];
    // Only include active (non-reversed) payments in the invoice snapshot
    const activePaymentsArray = paymentsArray.filter(p => !p.isReversed);

    const transformedPayments = activePaymentsArray.map((p) => {
      const paymentObject = p.toObject ? p.toObject() : p;
      return {
        ...paymentObject,
        method: p.method
          ? p.method.charAt(0).toUpperCase() + p.method.slice(1)
          : "",
      };
    });

    const paymentsMade = activePaymentsArray.reduce(
      (acc, payment) => acc + (payment.amount || 0),
      0,
    );
    const totalAmountToBePaid = sale.totalAmountToBePaid || 0;
    const balanceDue = Math.max(
      0,
      Math.round((totalAmountToBePaid - paymentsMade) * 100) / 100,
    );
    const overPayment = 0;

    const invoiceItems = sale.items.map((item) => ({
      productId: item.product._id,
      name: item.product.name,
      category: item.product.category?.name || "N/A",
      quantity: item.quantity,
      unit: item.unit._id,
      unitName: item.unit.name,
      pricePerUnit: item.pricePerUnit,
      total: item.total,
      remark: item.remark || "",
    }));

    const invoice = await Invoice.create({
      invoiceId: newInvoiceId,
      salesId: sale.saleId,
      salesDate: sale.saleDate,
      items: invoiceItems,

      customerDetails,
      paymentAndAmountInfo: {
        totalAmount: sale.totalAmount,
        costs: sale.costs,
        charges: sale.charges,
        discount: sale.discount,
        totalAmountToBePaid: totalAmountToBePaid,
        paymentStatus: sale.paymentStatus,
        payments: transformedPayments,
        paymentsMade,
        balanceDue,
        overPayment,
      },

      notes: sale.notes,
      createdBy: req.user?._id || null,
    });

    // Audit: Invoice generated
    auditService.log({
      action: "CREATE", module: "Invoice",
      documentId: invoice._id, displayId: invoice.invoiceId,
      userId: req.user?._id,
      description: `Generated invoice ${invoice.invoiceId} for sale ${sale.saleId}`,
      metadata: { salesId: sale.saleId, totalAmount: sale.totalAmountToBePaid },
      req,
    });

    return res
      .status(201)
      .json(new ApiResponse(201, invoice, "Invoice generated successfully"));
  } catch (error) {
    handleInvoiceError(error, next);
  }
}

async function getAllInvoices(req, res, next) {
  try {
    // Pagination support
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    const [invoices, totalCount] = await Promise.all([
      Invoice.aggregate([
        {
          $lookup: {
            from: "users",
            localField: "createdBy",
            foreignField: "_id",
            as: "creator",
          },
        },
        {
          $addFields: {
            createdBy: { $arrayElemAt: ["$creator", 0] },
          },
        },
        {
          $project: {
            creator: 0,
            "createdBy.password": 0,
          },
        },
        { $unwind: { path: "$items", preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: "units",
            localField: "items.unit",
            foreignField: "_id",
            as: "items.unit",
          },
        },
        { $unwind: { path: "$items.unit", preserveNullAndEmptyArrays: true } },
        {
          $group: {
            _id: "$_id",
            root: { $first: "$$ROOT" },
            items: { $push: "$items" },
          },
        },
        {
          $replaceRoot: {
            newRoot: {
              $mergeObjects: ["$root", { items: "$items" }],
            },
          },
        },
        { $sort: { createdAt: -1 } },
        { $skip: skip },
        { $limit: limit },
      ]),
      Invoice.countDocuments(),
    ]);

    return res.status(200).json(
      new ApiResponse(
        200,
        {
          invoices,
          pagination: {
            currentPage: page,
            totalPages: Math.ceil(totalCount / limit),
            totalCount,
            limit,
          },
        },
        "Invoices fetched successfully",
      ),
    );
  } catch (error) {
    handleInvoiceError(error, next);
  }
}

async function getInvoiceById(req, res, next) {
  try {
    const { id } = req.params;

    const results = await Invoice.aggregate([
      { $match: { _id: new mongoose.Types.ObjectId(id) } },

      // Lookup creator user
      {
        $lookup: {
          from: "users",
          localField: "createdBy",
          foreignField: "_id",
          as: "creator",
        },
      },
      {
        $addFields: {
          createdBy: { $arrayElemAt: ["$creator", 0] },
        },
      },
      {
        $project: {
          creator: 0,
          "createdBy.password": 0,
        },
      },

      // Populate items.unit
      { $unwind: { path: "$items", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "units",
          localField: "items.unit",
          foreignField: "_id",
          as: "items.unit",
        },
      },
      { $unwind: { path: "$items.unit", preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: "$_id",
          root: { $first: "$$ROOT" },
          items: { $push: "$items" },
        },
      },
      {
        $replaceRoot: {
          newRoot: {
            $mergeObjects: ["$root", { items: "$items" }],
          },
        },
      },

      // Lookup all accounts needed for payments and costs in a single stage
      {
        $lookup: {
          from: "accounts",
          let: {
            paymentAccountIds: "$paymentAndAmountInfo.payments.accountId",
            costAccountIds: "$paymentAndAmountInfo.costs.accountId",
          },
          pipeline: [
            {
              $match: {
                $expr: {
                  $or: [
                    { $in: ["$_id", "$$paymentAccountIds"] },
                    { $in: ["$_id", "$$costAccountIds"] },
                  ],
                },
              },
            },
          ],
          as: "accounts",
        },
      },

      // Lookup customer credit balance
      {
        $lookup: {
          from: "customers",
          localField: "customerDetails.customerId",
          foreignField: "_id",
          as: "customerLookup",
        },
      },

      // Final project — resolve account details inline
      {
        $project: {
          _id: 1,
          invoiceId: 1,
          salesId: 1,
          invoiceGeneratedDate: 1,
          salesDate: 1,
          items: 1,
          customerDetails: {
            $mergeObjects: [
              "$customerDetails",
              {
                creditBalance: {
                  $ifNull: [
                    { $arrayElemAt: ["$customerLookup.creditBalance", 0] },
                    null,
                  ],
                },
              },
            ],
          },
          notes: 1,
          createdAt: 1,
          updatedAt: 1,
          paymentAndAmountInfo: {
            totalAmount: "$paymentAndAmountInfo.totalAmount",
            charges: "$paymentAndAmountInfo.charges",
            discount: "$paymentAndAmountInfo.discount",
            totalAmountToBePaid: "$paymentAndAmountInfo.totalAmountToBePaid",
            paymentStatus: "$paymentAndAmountInfo.paymentStatus",
            paymentsMade: "$paymentAndAmountInfo.paymentsMade",
            balanceDue: "$paymentAndAmountInfo.balanceDue",
            overPayment: "$paymentAndAmountInfo.overPayment",
            payments: {
              $map: {
                input: "$paymentAndAmountInfo.payments",
                as: "payment",
                in: {
                  $mergeObjects: [
                    "$$payment",
                    {
                      accountDetails: {
                        $arrayElemAt: [
                          {
                            $filter: {
                              input: "$accounts",
                              as: "acc",
                              cond: {
                                $eq: ["$$acc._id", "$$payment.accountId"],
                              },
                            },
                          },
                          0,
                        ],
                      },
                    },
                  ],
                },
              },
            },
            costs: {
              $map: {
                input: "$paymentAndAmountInfo.costs",
                as: "cost",
                in: {
                  $mergeObjects: [
                    "$$cost",
                    {
                      accountDetails: {
                        $arrayElemAt: [
                          {
                            $filter: {
                              input: "$accounts",
                              as: "acc",
                              cond: { $eq: ["$$acc._id", "$$cost.accountId"] },
                            },
                          },
                          0,
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
    ]);

    if (results.length === 0) {
      return next(new ApiError(404, "Invoice not found"));
    }

    const invoice = results[0];

    return res
      .status(200)
      .json(new ApiResponse(200, invoice, "Invoice fetched successfully"));
  } catch (error) {
    handleInvoiceError(error, next);
  }
}

async function getInvoicesBySaleId(req, res, next) {
  try {
    const { saleId } = req.params;

    const sale = await Sales.findById(saleId).select("saleId").lean();
    if (!sale) {
      return next(new ApiError(404, "Sale not found"));
    }

    const invoices = await Invoice.aggregate([
      { $match: { salesId: sale.saleId } },
      {
        $addFields: {
          balanceDue: {
            $max: [
              0,
              {
                $subtract: [
                  "$paymentAndAmountInfo.totalAmountToBePaid",
                  { $sum: {
                    $map: {
                      input: { $filter: { input: "$paymentAndAmountInfo.payments", as: "p", cond: { $ne: ["$$p.isReversed", true] } } },
                      as: "ap",
                      in: "$$ap.amount"
                    }
                  }},
                ],
              },
            ],
          },
        },
      },
      {
        $project: {
          invoiceId: 1,
          invoiceGeneratedDate: 1,
          "paymentAndAmountInfo.totalAmountToBePaid": 1,
          balanceDue: 1,
          "customerDetails.name": 1,
          "customerDetails.phone": 1,
        },
      },
      { $sort: { createdAt: -1 } },
    ]);

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          invoices,
          "Invoices for the sale fetched successfully",
        ),
      );
  } catch (error) {
    handleInvoiceError(error, next);
  }
}

module.exports = {
  generateInvoice,
  getAllInvoices,
  getInvoiceById,
  getInvoicesBySaleId,
};
