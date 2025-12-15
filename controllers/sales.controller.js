const Sales = require("../models/sales.model");
const Product = require("../models/product.model");
const Customer = require("../models/customer.model");
const Unit = require("../models/unit.model"); // Import Unit model
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");

const Account = require("../models/account.model");
const { DailyCash } = require("../models/dailyCash.model");

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

    const validationErrors = [];
    if (saleDate) {
        const today = new Date();
        const providedSaleDate = new Date(saleDate);
        today.setHours(0, 0, 0, 0);
        providedSaleDate.setHours(0, 0, 0, 0);

        if (providedSaleDate > today) {
            validationErrors.push({
                field: "saleDate",
                message: "Sale date cannot be in the future."
            });
        }
    }
    if (!productId)
      validationErrors.push({
        field: "product",
        message: "Product ID is required",
      });
    if (!customerInfo || !customerInfo.name)
      validationErrors.push({
        field: "customer.name",
        message: "Customer name is required",
      });
    if (!warehouse)
      validationErrors.push({
        field: "warehouse",
        message: "Warehouse is required",
      });
    if (!category)
      validationErrors.push({
        field: "category",
        message: "Category is required",
      });
    if (!quantity)
      validationErrors.push({
        field: "quantity",
        message: "Quantity is required",
      });
    if (!unit)
      validationErrors.push({ field: "unit", message: "Unit is required" });
    if (!pricePerUnit)
      validationErrors.push({
        field: "pricePerUnit",
        message: "Price per unit is required",
      });

    if (validationErrors.length > 0) {
      throw new ApiError(400, "Validation failed", validationErrors);
    }

    const sellingProduct = await Product.findById(productId).session(session).populate('unit');
    if (!sellingProduct) {
      throw new ApiError(400, "Product not found");
    }

    const saleUnit = await Unit.findById(unit).session(session);
    if (!saleUnit) {
      throw new ApiError(400, "Sale unit not found");
    }

    // Check if units are compatible (same type)
    if (sellingProduct.unit.type !== saleUnit.type) {
      throw new ApiError(
        400,
        `Cannot sell product. Incompatible units: Product is in '${sellingProduct.unit.type}' while sale is in '${saleUnit.type}'.`
      );
    }

    // Calculate the quantity to deduct from stock in the product's base unit
    // First, convert the sale quantity to the common base unit (e.g., grams for weight, pieces for count)
    const saleQuantityInBaseUnit = quantity * saleUnit.conversionFactor;

    // Then, convert the product's current stock quantity to the common base unit
    const productStockInBaseUnit = sellingProduct.quantity * sellingProduct.unit.conversionFactor;

    // Now, check if there's enough stock in the common base unit
    if (productStockInBaseUnit < saleQuantityInBaseUnit) {
      throw new ApiError(400, "Not enough product in stock");
    }

    // Calculate the actual quantity to deduct from the product's stock (in its own unit)
    const quantityToDeductFromProduct = saleQuantityInBaseUnit / sellingProduct.unit.conversionFactor;

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

    // Handle payments and update account/cash accounts
    for (const payment of payments) {
      if (payment.method === "bank" || payment.method === "mobile-banking") {
        const account = await Account.findById(
          payment.account
        ).session(session);
        if (!account) {
          throw new ApiError(404, `Account not found for payment`);
        }
        account.balance += payment.amount;
        await account.save({ session });

        await Transaction.create(
          [
            {
              account: account._id,
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
      { $inc: { quantity: -quantityToDeductFromProduct } },
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

  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    
    // If the error is already one of our custom ApiErrors, just pass it along.
    // Otherwise, create a new generic one. This preserves the detailed validation errors.
    if (error instanceof ApiError) {
      return next(error);
    }
    next(new ApiError(500, error.message || "An internal server error occurred during sale creation."));
  }
}

async function getAllSales(_, res, next) {
  try {
    const sales = await Sales.find()
      .populate({
        path: "product",
        select: "name category unit LC",
        populate: [
          { path: "LC", select: "basicInfo.lcNumber" },
          { path: "unit", select: "name type conversionFactor" }
        ]
      })
      .populate("customer.customerId", "name phone location")
      .populate("warehouse", "name")
      .populate("category", "name")
      .populate({
        path: "payments.account",
        model: "Account",
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
        populate: [
          { path: "LC", select: "basicInfo.lcNumber" },
          { path: "unit", select: "name type conversionFactor" }
        ]
      })
      .populate("customer.customerId", "name phone location")
      .populate("warehouse", "name")
      .populate("category", "name description")
      .populate({
        path: "payments.account",
        model: "Account",
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

    const sale = await Sales.findById(id).populate('unit').populate({
      path: 'product',
      populate: {
        path: 'unit'
      }
    });
    if (!sale) {
      return next(new ApiError(404, "Sale not found"));
    }

    // Adjust product stock if quantity changes
    if (updateData.quantity && updateData.quantity !== sale.quantity) {
      const product = sale.product; // Product is already populated
      if (!product) {
        return next(new ApiError(404, "Associated product not found"));
      }

      // Check if units are compatible (same type)
      if (product.unit.type !== sale.unit.type) {
        return next(
          new ApiError(
            400,
            `Cannot update sale. Incompatible units: Product is in '${product.unit.type}' while sale is in '${sale.unit.type}'.`
          )
        );
      }

      // Calculate old and new sale quantities in a common base unit
      const oldSaleQuantityInBaseUnit = sale.quantity * sale.unit.conversionFactor;
      const newSaleQuantityInBaseUnit = updateData.quantity * sale.unit.conversionFactor;

      // Determine the net change in base units
      const netChangeInBaseUnit = newSaleQuantityInBaseUnit - oldSaleQuantityInBaseUnit;

      // Convert this net change to the product's unit
      const quantityChangeInProductUnit = netChangeInBaseUnit / product.unit.conversionFactor;

      // If quantityChangeInProductUnit is positive, it means we are increasing the sale quantity,
      // so we need to check if there's enough stock to deduct more.
      // If it's negative, we are decreasing the sale quantity, so stock will be returned.
      if (quantityChangeInProductUnit > 0 && product.quantity < quantityChangeInProductUnit) {
        return next(
          new ApiError(400, "Not enough product in stock for this quantity increase")
        );
      }

      await Product.findByIdAndUpdate(product._id, {
        $inc: { quantity: -quantityChangeInProductUnit },
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

    const deletedSale = await Sales.findByIdAndDelete(id).populate('unit').populate({
      path: 'product',
      populate: {
        path: 'unit'
      }
    });

    if (!deletedSale) {
      return next(new ApiError(404, "Sale not found"));
    }

    // Restore product quantity with unit conversion
    if (deletedSale.product && deletedSale.unit) {
      const product = deletedSale.product; // Product is already populated
      const saleUnit = deletedSale.unit; // Sale unit is already populated

      // Check if units are compatible (same type)
      if (product.unit.type !== saleUnit.type) {
        // Log an error or handle this case, as it indicates a data inconsistency
        console.error(
          `Data inconsistency: Product unit type (${product.unit.type}) does not match sale unit type (${saleUnit.type}) during sale deletion.`
        );
        // Proceed with a direct quantity restoration as a fallback, or throw an error
        await Product.findByIdAndUpdate(product._id, {
          $inc: { quantity: deletedSale.quantity },
        });
      } else {
        // Convert the deleted sale quantity to the product's base unit
        const deletedSaleQuantityInBaseUnit = deletedSale.quantity * saleUnit.conversionFactor;

        // Convert this quantity to the product's unit
        const quantityToRestoreToProduct = deletedSaleQuantityInBaseUnit / product.unit.conversionFactor;

        await Product.findByIdAndUpdate(product._id, {
          $inc: { quantity: quantityToRestoreToProduct },
        });
      }
    }

    // Reverse financial transactions and delete them
    for (const payment of deletedSale.payments) {
      if (payment.method === "bank" || payment.method === "mobile-banking") {
        const account = await Account.findById(payment.account);
        if (account) {
          account.balance -= payment.amount;
          await account.save();
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
        populate: [
          { path: "LC", select: "basicInfo.lcNumber" },
          { path: "unit", select: "name type conversionFactor" }
        ]
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
        populate: [
          { path: "LC", select: "basicInfo.lcNumber" },
          { path: "unit", select: "name type conversionFactor" }
        ]
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
        populate: [
          { path: "LC", select: "basicInfo.lcNumber" },
          { path: "unit", select: "name type conversionFactor" }
        ]
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
        populate: [
          { path: "LC", select: "basicInfo.lcNumber" },
          { path: "unit", select: "name type conversionFactor" }
        ]
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
    const { amount, date, method, account: accountId } = req.body;

    const validationErrors = [];
    if (!amount)
      validationErrors.push({ field: "amount", message: "Amount is required" });
    if (!date)
      validationErrors.push({ field: "date", message: "Date is required" });
    if (!method)
      validationErrors.push({ field: "method", message: "Method is required" });
    if (
      (method === "bank" || method === "mobile-banking") &&
      !accountId
    ) {
      validationErrors.push({
        field: "account",
        message: "Account is required for this payment method",
      });
    }

    if (validationErrors.length > 0) {
      throw new ApiError(400, "Validation failed", validationErrors);
    }

    const sale = await Sales.findById(id).session(session);
    if (!sale) {
      throw new ApiError(404, "Sale not found");
    }

    const payment = { amount, date, method };

    if (method === "bank" || method === "mobile-banking") {
      const account = await Account.findById(accountId).session(
        session
      );
      if (!account) {
        throw new ApiError(404, "Account not found");
      }
      payment.account = accountId;

      account.balance += amount;
      await account.save({ session });

      await Transaction.create(
        [
          {
            account: accountId,
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
        date,
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

    // If the error is already one of our custom ApiErrors, just pass it along.
    if (error instanceof ApiError) {
      return next(error);
    }
    next(new ApiError(500, error.message || "An internal server error occurred while adding partial payment."));
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
        populate: [
          { path: "LC", select: "basicInfo.lcNumber" },
          { path: "unit", select: "name type conversionFactor" }
        ]
      })
      .populate("warehouse", "name")
      .populate("category", "name")
      .populate({
        path: "payments.account",
        model: "Account",
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

async function cancelSale(req, res, next) {
  try {
    const { id } = req.params;

    const saleToCancel = await Sales.findById(id).populate('unit').populate({
      path: 'product',
      populate: {
        path: 'unit'
      }
    });

    if (!saleToCancel) {
      return next(new ApiError(404, "Sale not found"));
    }

    if (saleToCancel.invoiceStatus === "Cancelled") {
      return next(new ApiError(400, "Sale is already cancelled"));
    }

    // Reverse financial transactions by creating counter-transactions
    for (const payment of saleToCancel.payments) {
      if (payment.method === "bank" || payment.method === "mobile-banking") {
        const account = await Account.findById(payment.account);
        if (account) {
          account.balance -= payment.amount;
          await account.save();

          await Transaction.create({
            account: account._id,
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

    // Restore product quantity with unit conversion
    if (saleToCancel.product && saleToCancel.unit) {
      const product = saleToCancel.product; // Product is already populated
      const saleUnit = saleToCancel.unit; // Sale unit is already populated

      // Check if units are compatible (same type)
      if (product.unit.type !== saleUnit.type) {
        // Log an error or handle this case, as it indicates a data inconsistency
        console.error(
          `Data inconsistency: Product unit type (${product.unit.type}) does not match sale unit type (${saleUnit.type}) during sale cancellation.`
        );
        // Proceed with a direct quantity restoration as a fallback, or throw an error
        await Product.findByIdAndUpdate(product._id, {
          $inc: { quantity: saleToCancel.quantity },
        });
      } else {
        // Convert the cancelled sale quantity to the product's base unit
        const cancelledSaleQuantityInBaseUnit = saleToCancel.quantity * saleUnit.conversionFactor;

        // Convert this quantity to the product's unit
        const quantityToRestoreToProduct = cancelledSaleQuantityInBaseUnit / product.unit.conversionFactor;

        await Product.findByIdAndUpdate(product._id, {
          $inc: { quantity: quantityToRestoreToProduct },
        });
      }
    }

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
  getSalesSummaryForTable, // Export the new function
};

async function getSalesSummaryForTable(req, res, next) {
  try {
    const sales = await Sales.find()
      .populate({
        path: "product",
        select: "name LC unit", // Select product name, LC, and unit
        populate: [
          { path: "LC", select: "basicInfo.lcNumber" }, // Populate LC and select lcNumber
          { path: "unit", select: "name" }, // Populate product's unit and select name
        ],
      })
      .populate("customer.customerId", "name") // Populate registered customer and select name
      .populate("unit", "name") // Populate sale's unit and select name
      .select(
        "_id quantity pricePerUnit totalAmount customer invoiceStatus paymentStatus saleDate"
      )
      .sort({ saleDate: -1 });

    const formattedSales = sales.map((sale) => ({
      _id: sale._id,
      product: {
        name: sale.product?.name,
        lcNumber: sale.product?.LC?.basicInfo?.lcNumber || "N/A",
      },
      quantity: sale.quantity,
      unit: sale.unit?.name || "N/A", // Use the populated sale unit name
      pricePerUnit: sale.pricePerUnit,
      totalAmount: sale.totalAmount,
      customer: {
        name: sale.customer?.customerId?.name || sale.customer?.name, // Prefer registered customer name, fallback to temporary
      },
      invoiceStatus: sale.invoiceStatus,
      paymentStatus: sale.paymentStatus,
      saleDate: sale.saleDate,
    }));

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          formattedSales,
          "Sales summary for table fetched successfully"
        )
      );
  } catch (error) {
    next(new ApiError(500, error.message));
  }
}
