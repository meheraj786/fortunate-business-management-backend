const Sales = require("../models/sales.model");
const Customer = require("../models/customer.model");
const Invoice = require("../models/invoice.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const logger = require("../utils/logger");
const Trash = require("../models/trash.model");
const mongoose = require("mongoose");

async function generateInvoice(req, res, next) {
  try {
    const { saleId } = req.body;

    if (!saleId) {
      const validationError = {
        field: "saleId",
        message: "Sale ID is required",
      };
      return next(new ApiError(400, validationError.message, [validationError]));
    }

    const sale = await Sales.findById(saleId).populate("product category unit");

    if (!sale) {
      return next(new ApiError(404, "Sale not found"));
    }

    if (sale.invoiceStatus !== "Invoiced") {
      return next(
        new ApiError(400, "Invoice can only be generated for confirmed sales.")
      );
    }

    // Find the most recent invoice for this sale to check for changes.
    const latestInvoice = await Invoice.findOne({ salesId: sale.saleId }).sort({
      createdAt: -1,
    });

    // If an invoice already exists, check if there have been meaningful changes.
    if (latestInvoice) {
      // Helper to sort and stringify financial arrays for comparison
      const areFinancialArraysEqual = (arrA, arrB) => {
        if (arrA.length !== arrB.length) return false;

        // Create a simplified, sorted string representation for comparison
        const sortAndStringify = (arr) =>
          arr
            .map(({ amount, name, method, date, accountId }) =>
              JSON.stringify({ amount, name, method, date: date?.toString(), accountId: accountId?.toString() })
            )
            .sort()
            .join(",");

        return sortAndStringify(arrA) === sortAndStringify(arrB);
      };
      
      if (
        areFinancialArraysEqual(sale.payments, latestInvoice.paymentAndAmountInfo.payments) &&
        areFinancialArraysEqual(sale.costs, latestInvoice.paymentAndAmountInfo.costs) &&
        areFinancialArraysEqual(sale.charges, latestInvoice.paymentAndAmountInfo.charges)
      ) {
        return next(new ApiError(400, "no new changes made in the sale"));
      }
    }

    const currentYear = new Date().getFullYear();
    const shortYear = currentYear.toString().slice(-2);
    
    // Find the last invoice to get the highest sequential number
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

    const transformedPayments = paymentsArray.map(p => {
        const paymentObject = p.toObject ? p.toObject() : p;
        return {
            ...paymentObject,
            method: p.method ? p.method.charAt(0).toUpperCase() + p.method.slice(1) : '',
        };
    });
    
    const paymentsMade = paymentsArray.reduce((acc, payment) => acc + (payment.amount || 0), 0);
    const totalAmountToBePaid = sale.totalAmountToBePaid || 0;
    const balanceDue = Math.max(0, totalAmountToBePaid - paymentsMade);
    const overPayment = Math.max(0, paymentsMade - totalAmountToBePaid);

    const invoice = await Invoice.create({
      invoiceId: newInvoiceId,
      salesId: sale.saleId,
      salesDate: sale.saleDate,
      productDetails: {
        productId: sale.product._id,
        name: sale.product.name,
        category: sale.category.name,
        quantity: sale.quantity,
        unit: sale.unit,
        pricePerUnit: sale.pricePerUnit,
      },
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
    });

    return res
      .status(201)
      .json(new ApiResponse(201, invoice, "Invoice generated successfully"));
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(new ApiError(409, `An invoice with the same ${field} '${value}' already exists.`)); // Specific message for invoice
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
        logger.error(error);
    next(new ApiError(500, "An unexpected error occurred. Please try again."));
  }
}

async function getAllInvoices(req, res, next) {
  try {
    const invoices = await Invoice.aggregate([
      {
        $lookup: {
          from: "units",
          localField: "productDetails.unit",
          foreignField: "_id",
          as: "productDetails.unit",
        },
      },
      {
        $unwind: {
          path: "$productDetails.unit",
          preserveNullAndEmptyArrays: true, // Keep invoices even if unit is not found
        },
      },
      {
        $sort: { createdAt: -1 },
      },
    ]);
    return res
      .status(200)
      .json(new ApiResponse(200, invoices, "Invoices fetched successfully"));
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(new ApiError(409, `An invoice with the same ${field} '${value}' already exists.`)); // Specific message for invoice
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
        logger.error(error);
    next(new ApiError(500, "An unexpected error occurred. Please try again."));
  }
}

async function getInvoiceById(req, res, next) {
  try {
    const { id } = req.params;


    const results = await Invoice.aggregate([
      { $match: { _id: new mongoose.Types.ObjectId(id) } },

      // Populate productDetails.unit
      {
        $lookup: {
          from: "units",
          localField: "productDetails.unit",
          foreignField: "_id",
          as: "productDetails.unit",
        },
      },
      {
        $unwind: {
          path: "$productDetails.unit",
          preserveNullAndEmptyArrays: true,
        },
      },

      // Populate accountDetails for each payment in paymentAndAmountInfo.payments
      {
        $addFields: {
          "paymentAndAmountInfo.payments": {
            $map: {
              input: "$paymentAndAmountInfo.payments",
              as: "payment",
              in: {
                $mergeObjects: [
                  "$$payment",
                  {
                    accountDetails: {
                      $cond: {
                        if: "$$payment.accountId",
                        then: {
                          $arrayElemAt: [
                            {
                              $filter: {
                                input: "$$ROOT.accounts", // Assuming accounts are looked up globally or passed in
                                as: "account",
                                cond: { $eq: ["$$account._id", "$$payment.accountId"] }
                              }
                            },
                            0
                          ]
                        },
                        else: null
                      }
                    }
                  }
                ]
              }
            }
          }
        }
      },
      // Populate accountDetails for each cost in paymentAndAmountInfo.costs
      {
        $addFields: {
          "paymentAndAmountInfo.costs": {
            $map: {
              input: "$paymentAndAmountInfo.costs",
              as: "cost",
              in: {
                $mergeObjects: [
                  "$$cost",
                  {
                    accountDetails: {
                      $cond: {
                        if: "$$cost.accountId",
                        then: {
                          $arrayElemAt: [
                            {
                              $filter: {
                                input: "$$ROOT.accounts", // Assuming accounts are looked up globally or passed in
                                as: "account",
                                cond: { $eq: ["$$account._id", "$$cost.accountId"] }
                              }
                            },
                            0
                          ]
                        },
                        else: null
                      }
                    }
                  }
                ]
              }
            }
          }
        }
      },
      // Lookup all accounts needed (for payments and costs) in a single lookup stage
      {
        $lookup: {
          from: "accounts",
          let: {
            paymentAccountIds: "$paymentAndAmountInfo.payments.accountId",
            costAccountIds: "$paymentAndAmountInfo.costs.accountId"
          },
          pipeline: [
            {
              $match: {
                $expr: {
                  $or: [
                    { $in: ["$_id", "$$paymentAccountIds"] },
                    { $in: ["$_id", "$$costAccountIds"] }
                  ]
                }
              }
            }
          ],
          as: "accounts"
        }
      },
      // Final project to reshape the document into the desired output format
      {
        $project: {
          _id: 1,
          invoiceId: 1,
          salesId: 1,
          invoiceGeneratedDate: 1,
          salesDate: 1,
          productDetails: 1,
          customerDetails: 1,
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
                              cond: { $eq: ["$$acc._id", "$$payment.accountId"] }
                            }
                          },
                          0
                        ]
                      }
                    }
                  ]
                }
              }
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
                              cond: { $eq: ["$$acc._id", "$$cost.accountId"] }
                            }
                          },
                          0
                        ]
                      }
                    }
                  ]
                }
              }
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
          `An invoice with the same ${field} '${value}' already exists.`
        )
      ); // Specific message for invoice
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
    next(new ApiError(500, "An unexpected error occurred. Please try again."));
  }
}

async function getInvoicesBySaleId(req, res, next) {
  try {
    const { saleId } = req.params; // This is the _id of the sale
    
    // Find the sale by its _id to get the string saleId
    const sale = await Sales.findById(saleId).select("saleId").lean();
    if (!sale) {
      return next(new ApiError(404, "Sale not found"));
    }
    
    // Use the string sale.saleId to find all associated invoices
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
                  { $sum: "$paymentAndAmountInfo.payments.amount" },
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
          "Invoices for the sale fetched successfully"
        )
      );
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyPattern[field];
      return next(
        new ApiError(
          409,
          `An invoice with the same ${field} '${value}' already exists.`
        )
      ); // Specific message for invoice
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
    next(new ApiError(500, "An unexpected error occurred. Please try again."));
  }
}

module.exports = {
  generateInvoice,
  getAllInvoices,
  getInvoiceById,
  getInvoicesBySaleId,
};
