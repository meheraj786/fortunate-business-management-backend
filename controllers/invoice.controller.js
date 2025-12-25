const Sales = require("../models/sales.model");
const Customer = require("../models/customer.model");
const Invoice = require("../models/invoice.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");

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
    const latestInvoice = await Invoice.findOne({ salesId: sale._id }).sort({
      createdAt: -1,
    });

    // If an invoice already exists, check if the sale has been updated since.
    if (latestInvoice && sale.updatedAt <= latestInvoice.createdAt) {
      return next(
        new ApiError(
          400,
          "No changes detected since the last invoice was generated"
        )
      );
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

    const invoice = await Invoice.create({
      invoiceId: newInvoiceId,
      salesId: sale._id,
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
        deliveryCharge: sale.deliveryCharge,
        otherCharges: sale.otherCharges,
        discount: sale.discount,
        totalAmountToBePaid: sale.totalAmountToBePaid,
        paymentStatus: sale.paymentStatus,
        payments: sale.payments,
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
    next(new ApiError(500, error.message || "Something went wrong"));
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
    next(new ApiError(500, error.message || "Something went wrong"));
  }
}

async function getInvoiceById(req, res, next) {
  try {
    const { id } = req.params;
    const invoice = await Invoice.findById(id).populate("productDetails.unit");

    if (!invoice) {
      return next(new ApiError(404, "Invoice not found"));
    }

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
    next(new ApiError(500, error.message || "Something went wrong"));
  }
}

async function getInvoicesBySaleId(req, res, next) {
  try {
    const { saleId } = req.params;
    const invoices = await Invoice.find({ salesId: saleId }).populate("productDetails.unit").sort({
      createdAt: -1,
    });

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
    next(new ApiError(500, error.message || "Something went wrong"));
  }
}

module.exports = {
  generateInvoice,
  getAllInvoices,
  getInvoiceById,
  getInvoicesBySaleId,
};
