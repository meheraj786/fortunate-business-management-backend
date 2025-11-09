const Sales = require("../models/sales.model");
const Product = require("../models/product.model");
const Customer = require("../models/customer.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");

const BankAccount = require("../models/bank.model");
const DailyCash = require("../models/dailyCash.model");

const mongoose = require("mongoose");
const Transaction = require("../models/transaction.model");

async function addCashIncomeFromSale(
  saleDate,
  amount,
  description,
  saleId,
  session
) {
  const targetDate = new Date(saleDate);
  targetDate.setHours(0, 0, 0, 0);

  const dailyCash = await DailyCash.findOne({ date: targetDate }).session(
    session
  );

  if (!dailyCash) {
    throw new ApiError(
      404,
      `Daily cash for ${targetDate.toDateString()} is not open. Cannot record cash payment.`
    );
  }
  if (dailyCash.isClosed) {
    throw new ApiError(
      400,
      `Daily cash for ${targetDate.toDateString()} is closed. Cannot record cash payment.`
    );
  }

  dailyCash.totalIncome += amount;
  dailyCash.runningBalance += amount;
  dailyCash.incomeList.push({
    category: "Sale",
    description: description,
    amount: amount,
    paymentMethod: "cash",
    sales: saleId,
    time: new Date().toLocaleTimeString(),
  });

  await dailyCash.save({ session });
}

async function createSale(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
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
      throw new ApiError(400, "Required fields are missing");
    }

    const sellingProduct = await Product.findById(productId).session(session);
    if (!sellingProduct) {
      throw new ApiError(400, "Product not found");
    }

    if (sellingProduct.quantity < quantity) {
      throw new ApiError(400, "Not enough product in stock");
    }

    const finalCustomerInfo = {
      name: customerInfo.name,
      phone: customerInfo.phone,
      address: customerInfo.address,
      customerId: null,
    };

    if (customerInfo.customerId) {
      const existingCustomer = await Customer.findById(
        customerInfo.customerId
      ).session(session);
      if (!existingCustomer) {
        throw new ApiError(400, "Customer not found");
      }
      finalCustomerInfo.customerId = existingCustomer._id;
      finalCustomerInfo.name = existingCustomer.name;
      finalCustomerInfo.phone = existingCustomer.phone;
      finalCustomerInfo.address = existingCustomer.location;
    }

    const sale = new Sales({
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

    // Handle payments and update bank/cash accounts
    for (const payment of payments) {
      if (payment.method === "bank" || payment.method === "mobile-banking") {
        const bankAccount = await BankAccount.findById(
          payment.bankAccount
        ).session(session);
        if (!bankAccount) {
          throw new ApiError(404, `Bank account not found for payment`);
        }
        bankAccount.balance += payment.amount;
        await bankAccount.save({ session });

        await Transaction.create(
          [
            {
              bankAccount: bankAccount._id,
              date: payment.date,
              description: `Sale to ${finalCustomerInfo.name}`,
              type: "Credit",
              amount: payment.amount,
              source: "Sale",
              reference: sale._id,
            },
          ],
          { session }
        );
      } else if (payment.method === "cash") {
        await addCashIncomeFromSale(
          sale.saleDate,
          payment.amount,
          `Payment for new sale to ${finalCustomerInfo.name}`,
          sale._id,
          session
        );
      }
    }

    await sale.save({ session });

    await Product.findByIdAndUpdate(
      productId,
      { $inc: { quantity: -quantity } },
      { new: true, session }
    );

    if (finalCustomerInfo.customerId) {
      await Customer.findByIdAndUpdate(
        finalCustomerInfo.customerId,
        {
          $push: { transactions: sale._id },
        },
        { session }
      );
    }

    await session.commitTransaction();
    session.endSession();

    return res
      .status(201)
      .json(new ApiResponse(201, sale, "Sale created successfully"));
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    next(new ApiError(error.statusCode || 500, error.message));
  }
}

async function getAllSales(_, res, next) {
  try {
    const sales = await Sales.find()
      .populate({
        path: "product",
        select: "name category unit LC",
        populate: { path: "LC", select: "basic_info.lc_number" },
      })
      .populate("customer.customerId", "name phone location")
      .populate("warehouse", "name")
      .populate("category", "name")
      .populate({
        path: "payments.bankAccount",
        model: "BankAccount",
      });

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
      .populate({
        path: "product",
        select: "name category unit LC",
        populate: { path: "LC", select: "basic_info.lc_number" },
      })
      .populate("customer.customerId", "name phone location")
      .populate("warehouse", "name")
      .populate("category", "name description")
      .populate({
        path: "payments.bankAccount",
        model: "BankAccount",
      });

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
    console.log(updateData);

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

    // Ensure paymentStatus is not manually updated
    if (updateData.paymentStatus) {
      delete updateData.paymentStatus;
    }

    // Prevent changing the product, warehouse, or category
    if (updateData.product) {
      delete updateData.product;
    }
    if (updateData.warehouse) {
      delete updateData.warehouse;
    }
    if (updateData.category) {
      delete updateData.category;
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

    // Reverse financial transactions and delete them
    for (const payment of deletedSale.payments) {
      if (payment.method === "bank" || payment.method === "mobile-banking") {
        const bankAccount = await BankAccount.findById(payment.bankAccount);
        if (bankAccount) {
          bankAccount.balance -= payment.amount;
          await bankAccount.save();
        }
      }
    }
    // Delete all transaction documents associated with this sale
    await Transaction.deleteMany({ reference: deletedSale._id });

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

async function getAll_not_invoices(req, res, next) {
  try {
    const sales = await Sales.find({ invoiceStatus: "Not-invoiced" })
      .populate({
        path: "product",
        select: "name category unit LC",
        populate: { path: "LC", select: "basic_info.lc_number" },
      })
      .populate("customer.customerId", "name phone location")
      .populate("warehouse", "name")
      .populate("category", "name");
    return res
      .status(200)
      .json(
        new ApiResponse(200, sales, "Not-invoiced sales fetched successfully")
      );
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

// Get all paid-invoice sales list
async function getAll_paid_invoices(req, res, next) {
  try {
    const sales = await Sales.find({
      invoiceStatus: "Invoiced",
      paymentStatus: "Paid payment",
    })
      .populate({
        path: "product",
        select: "name category unit LC",
        populate: { path: "LC", select: "basic_info.lc_number" },
      })
      .populate("customer.customerId", "name phone location")
      .populate("warehouse", "name")
      .populate("category", "name");
    return res
      .status(200)
      .json(
        new ApiResponse(200, sales, "Paid invoice sales fetched successfully")
      );
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

// Get all due-invoice sales list
async function getAll_due_invoices(req, res, next) {
  try {
    const sales = await Sales.find({
      invoiceStatus: "Invoiced",
      paymentStatus: "Due payment",
    })
      .populate({
        path: "product",
        select: "name category unit LC",
        populate: { path: "LC", select: "basic_info.lc_number" },
      })
      .populate("customer.customerId", "name phone location")
      .populate("warehouse", "name")
      .populate("category", "name");
    return res
      .status(200)
      .json(
        new ApiResponse(200, sales, "Due invoice sales fetched successfully")
      );
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

// Get all cancelled-invoice sales list
async function getAll_cancelled_invoices(req, res, next) {
  try {
    const sales = await Sales.find({ invoiceStatus: "Cancelled" })
      .populate({
        path: "product",
        select: "name category unit LC",
        populate: { path: "LC", select: "basic_info.lc_number" },
      })
      .populate("customer.customerId", "name phone location")
      .populate("warehouse", "name")
      .populate("category", "name");
    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          sales,
          "Cancelled invoice sales fetched successfully"
        )
      );
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

// get all sales invoices count in respose - suppose, total not invoiced sales (2), total paid {paid invoices are those, those's payment is completed} invoices sales (5)
async function getAll_invoices_status_count(req, res, next) {
  try {
    const stats = await Sales.aggregate([
      {
        $group: {
          _id: {
            invoiceStatus: "$invoiceStatus",
            paymentStatus: "$paymentStatus",
          },
          count: { $sum: 1 },
        },
      },
    ]);

    const counts = {
      notInvoiced: 0,
      paid: 0,
      due: 0,
      cancelled: 0,
    };

    stats.forEach((stat) => {
      if (stat._id.invoiceStatus === "Not-invoiced") {
        counts.notInvoiced += stat.count;
      } else if (stat._id.invoiceStatus === "Cancelled") {
        counts.cancelled += stat.count;
      } else if (stat._id.invoiceStatus === "Invoiced") {
        if (stat._id.paymentStatus === "Paid payment") {
          counts.paid += stat.count;
        } else if (stat._id.paymentStatus === "Due payment") {
          counts.due += stat.count;
        }
      }
    });

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          counts,
          "Invoice status count fetched successfully"
        )
      );
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

async function addPartialPayment(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const { amount, date, method, bankAccount: bankAccountId } = req.body;

    if (!amount || !date || !method) {
      throw new ApiError(400, "Amount, date, and method are required");
    }

    const sale = await Sales.findById(id).session(session);
    if (!sale) {
      throw new ApiError(404, "Sale not found");
    }

    const payment = { amount, date, method };

    if (method === "bank" || method === "mobile-banking") {
      if (!bankAccountId) {
        throw new ApiError(
          400,
          "Bank account is required for this payment method"
        );
      }
      const bankAccount = await BankAccount.findById(bankAccountId).session(
        session
      );
      if (!bankAccount) {
        throw new ApiError(404, "Bank account not found");
      }
      payment.bankAccount = bankAccountId;

      bankAccount.balance += amount;
      await bankAccount.save({ session });

      await Transaction.create(
        [
          {
            bankAccount: bankAccountId,
            date,
            description: `Partial payment for sale to ${sale.customer.name}`,
            type: "Credit",
            amount,
            source: "Sale",
            reference: sale._id,
          },
        ],
        { session }
      );
    } else if (method === "cash") {
      await addCashIncomeFromSale(
        sale.saleDate,
        amount,
        `Partial payment for sale to ${sale.customer.name}`,
        sale._id,
        session
      );
    }

    sale.payments.push(payment);
    await sale.save({ session });

    await session.commitTransaction();
    session.endSession();

    return res
      .status(200)
      .json(new ApiResponse(200, sale, "Partial payment added successfully"));
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    next(new ApiError(error.statusCode || 500, error.message));
  }
}

async function getSalesByCustomerId(req, res, next) {
  try {
    const { customerId } = req.params;
    const { invoiceStatus, paymentStatus } = req.query;

    if (!mongoose.Types.ObjectId.isValid(customerId)) {
      return next(new ApiError(400, "Invalid customer ID"));
    }

    const query = { "customer.customerId": customerId };

    if (invoiceStatus) {
      query.invoiceStatus = invoiceStatus;
    }

    if (paymentStatus) {
      query.paymentStatus = paymentStatus;
    }

    const sales = await Sales.find(query)
      .populate({
        path: "product",
        select: "name category unit LC",
        populate: { path: "LC", select: "basic_info.lc_number" },
      })
      .populate("warehouse", "name")
      .populate("category", "name")
      .populate({
        path: "payments.bankAccount",
        model: "BankAccount",
      })
      .sort({ saleDate: -1 });

    if (!sales) {
      return next(new ApiError(404, "No sales found for this customer"));
    }

    return res
      .status(200)
      .json(
        new ApiResponse(200, sales, "Customer sales fetched successfully")
      );
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}

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
  getAll_invoices_status_count,
  addPartialPayment,
  cancelSale,
  getSalesByCustomerId,
};

async function cancelSale(req, res, next) {
  try {
    const { id } = req.params;

    const saleToCancel = await Sales.findById(id);

    if (!saleToCancel) {
      return next(new ApiError(404, "Sale not found"));
    }

    if (saleToCancel.invoiceStatus === "Cancelled") {
      return next(new ApiError(400, "Sale is already cancelled"));
    }

    // Reverse financial transactions by creating counter-transactions
    for (const payment of saleToCancel.payments) {
      if (payment.method === "bank" || payment.method === "mobile-banking") {
        const bankAccount = await BankAccount.findById(payment.bankAccount);
        if (bankAccount) {
          bankAccount.balance -= payment.amount;
          await bankAccount.save();

          await Transaction.create({
            bankAccount: bankAccount._id,
            date: new Date(),
            description: `Reversal for cancelled sale to ${saleToCancel.customer.name}`,
            type: "Debit",
            amount: payment.amount,
            source: "Sale Cancellation",
            reference: saleToCancel._id,
          });
        }
      }
    }

    // Restore product quantity
    await Product.findByIdAndUpdate(saleToCancel.product, {
      $inc: { quantity: saleToCancel.quantity },
    });

    // Remove sale from customer's transactions if it's a registered customer
    if (saleToCancel.customer && saleToCancel.customer.customerId) {
      await Customer.findByIdAndUpdate(saleToCancel.customer.customerId, {
        $pull: { transactions: saleToCancel._id },
      });
    }

    saleToCancel.invoiceStatus = "Cancelled";
    saleToCancel.paymentStatus = undefined; // Clear payment status for cancelled sales
    await saleToCancel.save();

    return res
      .status(200)
      .json(new ApiResponse(200, saleToCancel, "Sale cancelled successfully"));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}
