const Sales = require("../models/sales.model");
const Product = require("../models/product.model");
const Customer = require("../models/customer.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");

async function createSale(req, res, next) {
  try {
    const {
      product: productId,
      customer: customerInfo, // { customerId, name, phone, address }
      warehouse,
      category,
      quantity,
      unit,
      pricePerUnit,
      deliveryCharge = 0,
      otherCharges = [],
      discount = 0,
      invoiceStatus,
      paymentStatus,
      payments = [],
      notes,
      saleDate,
    } = req.body;

    if (
      !productId ||
      !customerInfo ||
      !customerInfo.name ||
      !warehouse ||
      !category ||
      !quantity ||
      !unit ||
      !pricePerUnit
    ) {
      return next(new ApiError(400, "Required fields are missing"));
    }

    const sellingProduct = await Product.findById(productId);
    if (!sellingProduct) {
      return next(new ApiError(400, "Product not found"));
    }

    if (sellingProduct.quantity < quantity) {
      return next(new ApiError(400, "Not enough product in stock"));
    }

    const finalCustomerInfo = {
      name: customerInfo.name,
      phone: customerInfo.phone,
      address: customerInfo.address,
      customerId: null,
    };

    if (customerInfo.customerId) {
      const existingCustomer = await Customer.findById(customerInfo.customerId);
      if (!existingCustomer) {
        return next(new ApiError(400, "Customer not found"));
      }
      finalCustomerInfo.customerId = existingCustomer._id;
      finalCustomerInfo.name = existingCustomer.name;
      finalCustomerInfo.phone = existingCustomer.phone;
      finalCustomerInfo.address = existingCustomer.location; // Assuming 'location' in Customer model
    }

    const sale = await Sales.create({
      product: productId,
      customer: finalCustomerInfo,
      warehouse,
      category,
      quantity,
      unit,
      pricePerUnit,
      deliveryCharge,
      otherCharges,
      discount,
      invoiceStatus,
      paymentStatus,
      payments,
      notes,
      saleDate,
    });

    await Product.findByIdAndUpdate(
      productId,
      { $inc: { quantity: -quantity } },
      { new: true }
    );

    if (finalCustomerInfo.customerId) {
      await Customer.findByIdAndUpdate(finalCustomerInfo.customerId, {
        $push: { transactions: sale._id },
      });
    }

    return res
      .status(201)
      .json(new ApiResponse(201, sale, "Sale created successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function getAllSales(_, res, next) {
  try {
    const sales = await Sales.find()
      .populate("product", "name category unit")
      .populate("customer.customerId", "name phone location")
      .populate("warehouse", "name")
      .populate("category", "name");

    return res
      .status(200)
      .json(new ApiResponse(200, sales, "Sales fetched successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function getSaleById(req, res, next) {
  try {
    const { id } = req.params;
    const sale = await Sales.findById(id)
      .populate("product", "name category unit")
      .populate("customer.customerId", "name phone location")
      .populate("warehouse", "name")
      .populate("category", "name description");

    if (!sale) return next(new ApiError(404, "Sale not found"));

    return res
      .status(200)
      .json(new ApiResponse(200, sale, "Sale fetched successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function updateSale(req, res, next) {
  try {
    const { id } = req.params;
    const updateData = req.body;

    const sale = await Sales.findById(id);
    if (!sale) {
      return next(new ApiError(404, "Sale not found"));
    }

    // Adjust product stock if quantity changes
    if (updateData.quantity && updateData.quantity !== sale.quantity) {
      const product = await Product.findById(sale.product);
      if (!product) {
        return next(new ApiError(404, "Associated product not found"));
      }
      const quantityChange = updateData.quantity - sale.quantity;
      if (product.quantity < quantityChange) {
        return next(
          new ApiError(400, "Not enough product in stock for update")
        );
      }
      await Product.findByIdAndUpdate(sale.product, {
        $inc: { quantity: -quantityChange },
      });
    }

    Object.assign(sale, updateData);

    const updatedSale = await sale.save();

    return res
      .status(200)
      .json(new ApiResponse(200, updatedSale, "Sale updated successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function deleteSale(req, res, next) {
  try {
    const { id } = req.params;

    const deletedSale = await Sales.findByIdAndDelete(id);

    if (!deletedSale) {
      return next(new ApiError(404, "Sale not found"));
    }

    // Restore product quantity
    await Product.findByIdAndUpdate(deletedSale.product, {
      $inc: { quantity: deletedSale.quantity },
    });

    // Remove sale from customer's transactions if it's a registered customer
    if (deletedSale.customer && deletedSale.customer.customerId) {
      await Customer.findByIdAndUpdate(deletedSale.customer.customerId, {
        $pull: { transactions: deletedSale._id },
      });
    }

    return res
      .status(200)
      .json(new ApiResponse(200, deletedSale, "Sale deleted successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function getSalesSummary(_, res, next) {
  try {
    const sales = await Sales.find();

    const totalSales = sales.reduce((acc, s) => acc + (s.totalAmount || 0), 0);
    const totalTransactions = sales.length;

    const dailySummary = {};
    sales.forEach((sale) => {
      const day = sale.saleDate.toISOString().split("T")[0];
      if (!dailySummary[day]) dailySummary[day] = 0;
      dailySummary[day] += sale.totalAmount || 0;
    });

    return res.status(200).json(
      new ApiResponse(
        200,
        {
          totalSales,
          totalTransactions,
          dailySummary,
        },
        "Sales summary fetched successfully"
      )
    );
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

// Get all not-invoiced sales list
async function getAll_not_invoices(req, res) {}

// Get all paid-invoice sales list
async function getAll_paid_invoices(req, res) {}

// Get all due-invoice sales list
async function getAll_due_invoices(req, res) {}

// Get all cancelled-invoice sales list
async function getAll_cancelled_invoices(req, res) {}

// get all sales invoices count in respose - suppose, total not invoiced sales (2), total paid {paid invoices are those, those's payment is completed} invoices sales (5)
async function getAll_invoices_status_count(req, res) {}

module.exports = {
  createSale,
  getAllSales,
  getSaleById,
  updateSale,
  deleteSale,
  getSalesSummary,
  getAll_cancelled_invoices,
  getAll_due_invoices,
  getAll_paid_invoices,
  getAll_not_invoices,
};
