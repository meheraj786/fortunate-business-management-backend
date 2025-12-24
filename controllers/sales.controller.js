const Sales = require("../models/sales.model");
const Product = require("../models/product.model");
const Customer = require("../models/customer.model");
const Unit = require("../models/unit.model"); // Import Unit model
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");

const Account = require("../models/account.model");
const DailyCash = require("../models/dailyCash.model");

const mongoose = require("mongoose");
const Transaction = require("../models/transaction.model");



async function createSale(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    // Generate saleId
    const currentYear = new Date().getFullYear();
    const shortYear = currentYear.toString().slice(-2);
    
    // Find the last sale for the current year to get the highest sequential number
    const lastSale = await Sales.findOne({
      saleId: new RegExp(`^SALE-${shortYear}-`, "i"),
    }).sort({ saleId: -1 });

    let lastSaleIdNumber = 0;
    if (lastSale && lastSale.saleId) {
      const match = lastSale.saleId.match(/(\d+)$/);
      if (match) {
        lastSaleIdNumber = parseInt(match[1], 10);
      }
    }

    const newSaleId = `SALE-${shortYear}-${(lastSaleIdNumber + 1)
      .toString()
      .padStart(6, "0")}`; // Pad with 6 zeros for up to 999,999 sales per year

    req.body.saleId = newSaleId; // Assign the generated saleId to the request body

    const {
      product: productId,
      customer: customerInfo, // { customerId, name, phone, address }
      warehouse,
      category,
      quantity,
      unit,
      pricePerUnit,
      costs = [], // Replaces deliveryCharge and otherCharges
      discount = 0,
      invoiceStatus,
      paymentStatus,
      payments: originalPayments = [], // Rename to avoid conflict
      notes,
      saleDate,
    } = req.body;

    // Transform payments to ensure accountId is used consistently
    const transformedPayments = originalPayments.map(p => ({
      ...p,
      accountId: p.account || p.accountId, // Map 'account' to 'accountId' if present
      // Ensure 'account' field is not passed if 'accountId' is preferred by schema
      account: undefined
    }));

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
      throw new ApiError(400, validationErrors[0].message, validationErrors);
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
      saleId: req.body.saleId, // Explicitly pass saleId
      product: productId,
      customer: finalCustomerInfo,
      warehouse,
      category,
      quantity,
      unit,
      pricePerUnit,
      costs, // Use the new costs field
      discount,
      invoiceStatus,
      paymentStatus,
      payments: transformedPayments, // Use transformed payments
      notes,
      saleDate,
    });

    if (sale.totalAmountToBePaid < 0) {
      throw new ApiError(400, "Total amount to be paid cannot be negative.");
    }

    // Handle payments and update account balances
    for (const payment of transformedPayments) { // Iterate over transformed payments
      // For any account-based payment, we need an account ID
      if (["Bank", "Mobile Banking", "Cash"].includes(payment.method)) {
        if (!payment.accountId) { // Check for accountId
          throw new ApiError(
            400,
            `Account ID is required for ${payment.method} payment.`
          );
        }
        const account = await Account.findById(payment.accountId).session(session); // Use payment.accountId
        if (!account) {
          throw new ApiError(404, `Account not found for payment.`);
        }

        // Validate that the account type matches the payment method
        const expectedAccountType =
          payment.method === "Mobile Banking" ? "Mobile Banking" : payment.method;
        if (account.accountType !== expectedAccountType) {
          throw new ApiError(
            400,
            `Payment method '${payment.method}' requires a '${expectedAccountType}' account, but a '${account.accountType}' account was provided.`
          );
        }

        // Increase account balance
        account.balance += payment.amount;
        await account.save({ session });

        // Create a corresponding transaction record
        // 1. DailyCash Gatekeeper Check
        const paymentDateNormalized = new Date(payment.date);
        paymentDateNormalized.setHours(0, 0, 0, 0);
        const dailyCash = await DailyCash.findOne({ date: paymentDateNormalized }).session(session);

        if (!dailyCash || dailyCash.status === "Closed") {
          throw new ApiError(
            400,
            `Daily cash is closed for ${paymentDateNormalized.toDateString()}. Cannot record payment.`
          );
        }

        await Transaction.create(
          [
            {
              accountId: account._id,
              date: payment.date,
              description: `Payment received for Sale ID: ${req.body.saleId} from ${finalCustomerInfo.name} via ${payment.method}.`,
              transactionType: "Income",
              amount: payment.amount,
              name: "Sales Payment",
              source: "Auto",
              category: "Sales",
              paymentMethod: payment.method,
              reference: sale._id,
              referenceModel: "Sale",
              miscReference: {
                saleId: req.body.saleId,
                customerName: finalCustomerInfo.name,
                paymentAmount: payment.amount,
                paymentMethod: payment.method,
              },
            },
          ],
          { session }
        );
      }
    }

    await sale.save({ session });

    // Create expense transactions for each cost associated with the sale
    for (const cost of sale.costs) {
      if (cost.accountId) {
        const costAccount = await Account.findById(cost.accountId).session(session);
        if (!costAccount) {
          throw new ApiError(404, `Account for cost '${cost.name}' not found.`);
        }

        // DailyCash check for the cost transaction date
        const saleDateNormalized = new Date(sale.saleDate);
        saleDateNormalized.setHours(0, 0, 0, 0);
        const dailyCash = await DailyCash.findOne({ date: saleDateNormalized }).session(session);

        if (!dailyCash || dailyCash.status === "Closed") {
          throw new ApiError(
            400,
            `Daily cash is closed for ${saleDateNormalized.toDateString()}. Cannot record cost transaction.`
          );
        }

        costAccount.balance -= cost.amount;
        await costAccount.save({ session });

        await Transaction.create(
          [
            {
              accountId: cost.accountId,
              date: sale.saleDate,
              description: `Cost for sale ${sale.saleId}: ${cost.name}`,
              transactionType: "Expense",
              amount: cost.amount,
              name: `Sale Cost - ${cost.name}`,
              source: "Auto",
              category: "Sales Expense",
              reference: sale._id,
              referenceModel: "Sale",
              miscReference: {
                saleId: sale.saleId,
                costName: cost.name,
                costAmount: cost.amount,
              },
            },
          ],
          { session }
        );
      }
    }

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
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(new ApiError(409, `A sale with the same ${field} '${value}' already exists.`)); // Specific message for sales
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
        path: "payments.accountId",
        model: "Account",
      });

    return res
      .status(200)
      .json(new ApiResponse(200, sales, "Sales fetched successfully"));
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
        path: "payments.accountId",
        model: "Account",
      });

    if (!sale) return next(new ApiError(404, "Sale not found"));

    return res
      .status(200)
      .json(new ApiResponse(200, sale, "Sale fetched successfully"));
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

async function deleteSale(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;

    const deletedSale = await Sales.findByIdAndDelete(id, { session })
      .populate('unit')
      .populate({
        path: 'product',
        populate: {
          path: 'unit'
        }
      });

    if (!deletedSale) {
      throw new ApiError(404, "Sale not found");
    }

    // Restore product quantity with unit conversion
    if (deletedSale.product && deletedSale.unit) {
      const product = deletedSale.product; // Product is already populated
      const saleUnit = deletedSale.unit; // Sale unit is already populated

      // Check if units are compatible (same type)
      if (product.unit.type !== saleUnit.type) {
        console.error(
          `Data inconsistency: Product unit type (${product.unit.type}) does not match sale unit type (${saleUnit.type}) during sale deletion.`
        );
        await Product.findByIdAndUpdate(product._id, {
          $inc: { quantity: deletedSale.quantity },
        }, { session });
      } else {
        const deletedSaleQuantityInBaseUnit = deletedSale.quantity * saleUnit.conversionFactor;
        const quantityToRestoreToProduct = deletedSaleQuantityInBaseUnit / product.unit.conversionFactor;

        await Product.findByIdAndUpdate(product._id, {
          $inc: { quantity: quantityToRestoreToProduct },
        }, { session });
      }
    }

    // Reverse financial transactions by creating counter-transactions
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dailyCash = await DailyCash.findOne({ date: today }).session(session);

    if (!dailyCash || dailyCash.status === "Closed") {
        throw new ApiError(400, `Daily cash is closed for ${today.toDateString()}. Cannot reverse sales payments.`);
    }

    // Reverse financial transactions for payments
    for (const payment of deletedSale.payments) {
      if (["Bank", "Mobile Banking", "Cash"].includes(payment.method)) {
        const account = await Account.findById(payment.accountId).session(session);
        if (account) {
          account.balance -= payment.amount;
          await account.save({ session });

          await Transaction.create([{
            accountId: payment.accountId,
            date: new Date(), // Reversal transaction date is today
            description: `Reversal of payment for Sale ID: ${deletedSale.saleId} (Customer: ${deletedSale.customer.name}) via ${payment.method}.`,
            transactionType: "Expense", // To reverse the Income
            amount: payment.amount,
            source: "Auto", // Auto generated reversal
            category: "Sales Reversal",
            reference: deletedSale._id,
            referenceModel: "Sale",
miscReference: {
              saleId: deletedSale.saleId,
              customerName: deletedSale.customer.name,
              originalPaymentAmount: payment.amount,
              originalPaymentMethod: payment.method,
            },
          }], { session });
        }
      }
    }
    
    // Reverse expense transactions for costs
    for (const cost of deletedSale.costs) {
      if (cost.accountId) {
        const account = await Account.findById(cost.accountId).session(session);
        if (account) {
          account.balance += cost.amount;
          await account.save({ session });

          await Transaction.create(
            [
              {
                accountId: cost.accountId,
                date: new Date(),
                description: `Reversal of cost for deleted Sale ID: ${deletedSale.saleId} - ${cost.name}`,
                transactionType: "Income", // To reverse the Expense
                amount: cost.amount,
                source: "Auto",
                category: "Sales Expense Reversal",
                reference: deletedSale._id,
                referenceModel: "Sale",
                miscReference: {
                  saleId: deletedSale.saleId,
                  costName: cost.name,
                  costAmount: cost.amount,
                },
              },
            ],
            { session }
          );
        }
      }
    }
    
    // Remove sale from customer's transactions if it's a registered customer
    if (deletedSale.customer && deletedSale.customer.customerId) {
      await Customer.findByIdAndUpdate(
        deletedSale.customer.customerId,
        {
          $pull: { transactions: deletedSale._id },
        },
        { session }
      );
    }

    await session.commitTransaction();
    session.endSession();

    return res
      .status(200)
      .json(new ApiResponse(200, deletedSale, "Sale deleted successfully"));
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
      return next(new ApiError(409, `A sale with the same ${field} '${value}' already exists.`)); // Generic message for sales
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
    
    // Account is required for all payment methods now as per new schema
    if (!accountId) {
      validationErrors.push({
        field: "account",
        message: "Account is required for the payment",
      });
    }

    if (validationErrors.length > 0) {
      throw new ApiError(400, validationErrors[0].message, validationErrors);
    }

    const sale = await Sales.findById(id).session(session);
    if (!sale) {
      throw new ApiError(404, "Sale not found");
    }

    const payment = { amount, date, method, accountId: accountId };

    // For any account-based payment, we need an account ID
    if (["Bank", "Mobile Banking", "Cash"].includes(method)) {
        // 1. DailyCash Gatekeeper Check
        const paymentDateNormalized = new Date(date);
        paymentDateNormalized.setHours(0, 0, 0, 0);
        const dailyCash = await DailyCash.findOne({ date: paymentDateNormalized }).session(session);

        if (!dailyCash || dailyCash.status === "Closed") {
          throw new ApiError(
            400,
            `Daily cash is closed for ${paymentDateNormalized.toDateString()}. Cannot record payment.`
          );
        }

        const account = await Account.findById(accountId).session(session);
        if (!account) {
            throw new ApiError(404, "Account not found");
        }

        // Validate that the account type matches the payment method
        const expectedAccountType =
            method === "Mobile Banking" ? "Mobile Banking" : method;
        if (account.accountType !== expectedAccountType) {
            throw new new ApiError(
                400,
                `Payment method '${method}' requires a '${expectedAccountType}' account, but a '${account.accountType}' account was provided.`
            );
        }

        account.balance += amount;
        await account.save({ session });

        await Transaction.create(
            [
                {
                    accountId: accountId,
                    date,
                    description: `Partial payment received for Sale ID: ${sale.saleId} from ${sale.customer.name} via ${method}.`,
                    transactionType: "Income",
                    amount,
                    source: "Auto",
                    category: "Sales",
                    reference: sale._id,
                    referenceModel: "Sale",
                    miscReference: {
                        saleId: sale.saleId,
                        customerName: sale.customer.name,
                        paymentAmount: amount,
                        paymentMethod: method,
                    },
                },
            ],
            { session }
        );
    } // Correctly close the if block here

    // These operations should happen regardless of the payment method specific logic
    sale.payments.push(payment);
    await sale.save({ session });

    await session.commitTransaction();
    session.endSession();

    return res
      .status(200)
      .json(new ApiResponse(200, sale, "Partial payment added successfully"));
  } catch (error) { // The catch block now properly follows the try block
    await session.abortTransaction();
    session.endSession();

    // If the error is already one of our custom ApiErrors, just pass it along.
    if (error instanceof ApiError) {
      return next(error);
    }
    // Handle MongoServerError for duplicate key (unique: true)
    if (error.code === 11000 && error.keyPattern && error.keyValue) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(new ApiError(409, `A sale with the same ${field} '${value}' already exists.`)); // Generic message for sales
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
    next(new ApiError(500, error.message || "An internal server error occurred while adding partial payment."));
  }
}

async function getSalesByCustomerId(req, res, next) {
  try {
    const { customerId } = req.params;
    const { 
      invoiceStatus, 
      paymentStatus, 
      page = 1, 
      limit = 10 
    } = req.query;

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

    const options = {
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
      sort: { saleDate: -1 },
      select: 'saleDate product quantity unit pricePerUnit totalAmountToBePaid invoiceStatus paymentStatus',
      populate: [
        { 
          path: 'product', 
          select: 'name LC',
          populate: {
            path: 'LC',
            select: 'basicInfo.lcNumber' // Select LC number
          }
        },
        { path: 'unit', select: 'name' } // Select unit name
      ],
      lean: true
    };

    const salesResult = await Sales.paginate(query, options);

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          {
            sales: salesResult.docs,
            totalPages: salesResult.totalPages,
            currentPage: salesResult.page,
            totalItems: salesResult.totalDocs,
          },
          "Customer sales fetched successfully"
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

async function cancelSale(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;

    const saleToCancel = await Sales.findById(id, { session })
      .populate('unit')
      .populate({
        path: 'product',
        populate: {
          path: 'unit'
        }
      });

    if (!saleToCancel) {
      throw new ApiError(404, "Sale not found");
    }

    if (saleToCancel.invoiceStatus === "Cancelled") {
      throw new ApiError(400, "Sale is already cancelled");
    }

    // DailyCash Gatekeeper Check for reversal transactions
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dailyCash = await DailyCash.findOne({ date: today }).session(session);

    if (!dailyCash || dailyCash.status === "Closed") {
        throw new ApiError(400, `Daily cash is closed for ${today.toDateString()}. Cannot cancel sales payments.`);
    }

    // Reverse financial transactions by creating counter-transactions
    for (const payment of saleToCancel.payments) {
      if (["Bank", "Mobile Banking", "Cash"].includes(payment.method)) {
        const account = await Account.findById(payment.accountId).session(session);
        if (account) {
          account.balance -= payment.amount;
          await account.save({ session });

          await Transaction.create([{
            accountId: payment.accountId,
            date: new Date(), // Reversal transaction date is today
            description: `Reversal of payment for cancelled Sale ID: ${saleToCancel.saleId} (Customer: ${saleToCancel.customer.name}) via ${payment.method}.`,
            transactionType: "Expense", // To reverse the Income
            amount: payment.amount,
            source: "Auto", // Auto generated reversal
            category: "Sales Reversal (Cancelled)",
            reference: saleToCancel._id,
            referenceModel: "Sale",
            miscReference: {
              saleId: saleToCancel.saleId,
              customerName: saleToCancel.customer.name,
              originalPaymentAmount: payment.amount,
              originalPaymentMethod: payment.method,
            },
          }], { session });
        }
      }
    }

    // Reverse expense transactions for costs
    for (const cost of saleToCancel.costs) {
      if (cost.accountId) {
        const account = await Account.findById(cost.accountId).session(session);
        if (account) {
          account.balance += cost.amount;
          await account.save({ session });

          await Transaction.create(
            [
              {
                accountId: cost.accountId,
                date: new Date(),
                description: `Reversal of cost for cancelled Sale ID: ${saleToCancel.saleId} - ${cost.name}`,
                transactionType: "Income", // To reverse the Expense
                amount: cost.amount,
                source: "Auto",
                category: "Sales Expense Reversal",
                reference: saleToCancel._id,
                referenceModel: "Sale",
                miscReference: {
                  saleId: saleToCancel.saleId,
                  costName: cost.name,
                  costAmount: cost.amount,
                },
              },
            ],
            { session }
          );
        }
      }
    }

    // Restore product quantity with unit conversion
    if (saleToCancel.product && saleToCancel.unit) {
      const product = saleToCancel.product; // Product is already populated
      const saleUnit = saleToCancel.unit; // Sale unit is already populated

      // Check if units are compatible (same type)
      if (product.unit.type !== saleUnit.type) {
        console.error(
          `Data inconsistency: Product unit type (${product.unit.type}) does not match sale unit type (${saleUnit.type}) during sale cancellation.`
        );
        await Product.findByIdAndUpdate(product._id, {
          $inc: { quantity: saleToCancel.quantity },
        }, { session });
      } else {
        const cancelledSaleQuantityInBaseUnit = saleToCancel.quantity * saleUnit.conversionFactor;
        const quantityToRestoreToProduct = cancelledSaleQuantityInBaseUnit / product.unit.conversionFactor;

        await Product.findByIdAndUpdate(product._id, {
          $inc: { quantity: quantityToRestoreToProduct },
        }, { session });
      }
    }

    // Remove sale from customer's transactions if it's a registered customer
    if (saleToCancel.customer && saleToCancel.customer.customerId) {
      await Customer.findByIdAndUpdate(saleToCancel.customer.customerId, {
        $pull: { transactions: saleToCancel._id },
      }, { session });
    }

    saleToCancel.invoiceStatus = "Cancelled";
    saleToCancel.paymentStatus = undefined; // Clear payment status for cancelled sales
    await saleToCancel.save({ session });

    await session.commitTransaction();
    session.endSession();

    return res
      .status(200)
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
      return next(new ApiError(409, `A sale with the same ${field} '${value}' already exists.`)); // Generic message for sales
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

async function getPaginatedSalesSummary(req, res, next) {
  try {
    const {
      page = 1,
      limit = 10,
      invoiceStatus,
      paymentStatus,
      search,
      sortBy,
      sortOrder = "desc", // default to descending order
    } = req.query;

    const pipeline = [];

    // Stage 1: Add fields for searching and sorting that require population
    pipeline.push({
      $lookup: {
        from: "products",
        localField: "product",
        foreignField: "_id",
        as: "productDetails",
      },
    });
    pipeline.push({
      $unwind: "$productDetails",
    });

    pipeline.push({
      $lookup: {
        from: "lcs",
        localField: "productDetails.LC",
        foreignField: "_id",
        as: "lcDetails",
      },
    });
    pipeline.push({
      $unwind: { path: "$lcDetails", preserveNullAndEmptyArrays: true }, // LC might be null
    });

    pipeline.push({
      $lookup: {
        from: "units",
        localField: "unit",
        foreignField: "_id",
        as: "saleUnitDetails",
      },
    });
    pipeline.push({
      $unwind: "$saleUnitDetails",
    });

    pipeline.push({
      $lookup: {
        from: "customers",
        localField: "customer.customerId",
        foreignField: "_id",
        as: "customerLookup",
      },
    });
    pipeline.push({
      $unwind: { path: "$customerLookup", preserveNullAndEmptyArrays: true },
    });

    // Stage 2: Filtering
    const matchConditions = {};
    if (invoiceStatus) {
      matchConditions.invoiceStatus = invoiceStatus;
    }
    if (paymentStatus) {
      matchConditions.paymentStatus = paymentStatus;
    }

    if (search) {
      const searchRegex = new RegExp(search, "i");
      matchConditions.$or = [
        { "customer.name": searchRegex },
        { "customerLookup.name": searchRegex },
        { "productDetails.name": searchRegex },
        { "lcDetails.basicInfo.lcNumber": searchRegex },
        { totalAmountToBePaid: parseFloat(search) || -1 }, // Search by amount
      ];
    }
    
    if (Object.keys(matchConditions).length > 0) {
      pipeline.push({ $match: matchConditions });
    }

    // Stage 3: Add calculated field for quantity sorting
    pipeline.push({
      $addFields: {
        convertedQuantity: {
          $multiply: ["$quantity", "$saleUnitDetails.conversionFactor"],
        },
        finalCustomerName: {
          $cond: {
            if: "$customerLookup.name",
            then: "$customerLookup.name",
            else: "$customer.name",
          },
        },
      },
    });

    // Stage 4: Sorting
    const sort = {};
    if (sortBy) {
      if (sortBy === "saleDate") {
        sort.saleDate = sortOrder === "asc" ? 1 : -1;
      } else if (sortBy === "totalAmountToBePaid") {
        sort.totalAmountToBePaid = sortOrder === "bigger" ? -1 : 1; // bigger = desc, smaller = asc
      } else if (sortBy === "quantity") {
        sort.convertedQuantity = sortOrder === "asc" ? 1 : -1;
      } else if (sortBy === "customerName") {
        sort.finalCustomerName = sortOrder === "asc" ? 1 : -1;
      }
    } else {
      // Default sort
      sort.saleDate = -1;
    }

    pipeline.push({ $sort: sort });

    // Stage 5: Pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    pipeline.push({ $skip: skip });
    pipeline.push({ $limit: parseInt(limit) });

    // Stage 6: Project the final output fields
    pipeline.push({
      $project: {
        _id: "$_id",
        "customer.name": "$finalCustomerName",
        "product.name": "$productDetails.name",
        "product.id": "$productDetails._id",
        "lc.number": "$lcDetails.basicInfo.lcNumber",
        "lc.id": "$lcDetails._id",
        quantity: "$quantity",
        "unit.name": "$saleUnitDetails.name",
        "unit.id": "$saleUnitDetails._id",
        pricePerUnit: "$pricePerUnit",
        totalAmountToBePaid: "$totalAmountToBePaid",
        invoiceStatus: "$invoiceStatus",
        paymentStatus: "$paymentStatus",
        saleDate: "$saleDate",
      },
    });

    const sales = await Sales.aggregate(pipeline);

    // Get total count for pagination metadata
    const countPipeline = [...pipeline];
    countPipeline.pop(); // Remove $project
    countPipeline.pop(); // Remove $limit
    countPipeline.pop(); // Remove $skip
    countPipeline.pop(); // Remove $sort

    countPipeline.push({ $count: "total" });
    const totalCountResult = await Sales.aggregate(countPipeline);
    const totalSales = totalCountResult.length > 0 ? totalCountResult[0].total : 0;

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          {
            sales,
            totalSales,
            page: parseInt(page),
            limit: parseInt(limit),
            totalPages: Math.ceil(totalSales / parseInt(limit)),
          },
          "Sales summary fetched successfully"
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
    next(new ApiError(500, error.message || "An internal server error occurred while fetching sales summary."));
  }
}

module.exports = {
  createSale,
  getAllSales,
  getSaleById,
  updateSale,
  deleteSale,
  getSalesSummary,
  getAll_invoices_status_count,
  addPartialPayment,
  cancelSale,
  getSalesByCustomerId,
  getPaginatedSalesSummary,
};


