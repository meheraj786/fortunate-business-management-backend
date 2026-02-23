const mongoose = require("mongoose");
const { ApiResponse } = require("../utils/ApiResponse");
const { ApiError } = require("../utils/ApiError");
const logger = require("../utils/logger");
const auditService = require("../services/audit.service");

// Import all models to be cleared
const Sale = require("../models/sales.model");
const LC = require("../models/lc.model");
const Product = require("../models/product.model");
const Category = require("../models/category.model");
const Unit = require("../models/unit.model");
const Warehouse = require("../models/warehouse.model");
const Customer = require("../models/customer.model");
const Account = require("../models/account.model");
const Transaction = require("../models/transaction.model");
const DailyCash = require("../models/dailyCash.model");
// invoice.model.js might exist, checking list... yes it does.
const Invoice = require("../models/invoice.model");
const Trash = require("../models/trash.model");
const User = require("../models/user.model");
const SystemSettings = require("../models/systemSettings.model");

// Helper to clear a collection
const clearCollection = async (Model, session) => {
  await Model.deleteMany({}, { session });
};

/**
 * Clear specific module data
 */
exports.clearModuleData = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { moduleName } = req.params;
    let message = "";

    switch (moduleName) {
      case "sales":
        await clearCollection(Sale, session);
        // Also clear Invoices related to sales? usually separate but often linked.
        // For strict module clear, just Sales collection might be requested,
        // but Sales usually imply Invoices too. Let's clear Invoices too to be clean.
        await clearCollection(Invoice, session);
        message = "Sales and Invoices data cleared successfully.";
        break;

      case "lc":
        await clearCollection(LC, session);
        message = "LC (Letter of Credit) data cleared successfully.";
        break;

      case "inventory":
        await clearCollection(Product, session);
        await clearCollection(Category, session);
        await clearCollection(Unit, session);
        await clearCollection(Warehouse, session);
        message =
          "Inventory (Products, Categories, Units, Warehouses) cleared successfully.";
        break;

      case "customers":
        await clearCollection(Customer, session);
        message = "Customer database cleared successfully.";
        break;

      case "accounts":
        await clearCollection(Account, session);
        await clearCollection(Transaction, session);
        await clearCollection(DailyCash, session);
        message =
          "Accounts, Transactions, and Daily Cash history cleared successfully.";
        break;

      case "trash":
        await clearCollection(Trash, session);
        message = "Trash bin emptied successfully.";
        break;

      default:
        throw new ApiError(400, `Unknown module name: ${moduleName}`);
    }

    await session.commitTransaction();
    session.endSession();

    logger.info(`Module Data Cleared: ${moduleName} by ${req.user.email}`);

    auditService.log({
      action: "WIPE",
      module: "System",
      userId: req.user?._id,
      description: `Wiped ${moduleName} module data`,
      metadata: { moduleName },
      req,
    });

    return res.status(200).json(new ApiResponse(200, null, message));
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    if (error instanceof ApiError) return next(error);
    next(new ApiError(500, `Failed to clear ${req.params.moduleName} data.`));
  }
};

/**
 * Clear All Business Data (Preserve Users & Settings)
 */
exports.clearBusinessData = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    // 1. Sales & Invoices
    await clearCollection(Sale, session);
    await clearCollection(Invoice, session);

    // 2. LC
    await clearCollection(LC, session);

    // 3. Inventory
    await clearCollection(Product, session);
    await clearCollection(Category, session);
    await clearCollection(Unit, session);
    await clearCollection(Warehouse, session);

    // 4. Customers
    await clearCollection(Customer, session);

    // 5. Accounts & Finance
    await clearCollection(Account, session);
    await clearCollection(Transaction, session);
    await clearCollection(DailyCash, session);

    // 6. Trash
    await clearCollection(Trash, session);

    await session.commitTransaction();
    session.endSession();

    logger.info(`Business Data Wipeout performed by ${req.user.email}`);

    auditService.log({
      action: "WIPE",
      module: "System",
      userId: req.user?._id,
      description: `Wiped all business data (users & settings preserved)`,
      req,
    });

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          null,
          "All business data has been wiped. Users and System Settings are preserved.",
        ),
      );
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    next(new ApiError(500, "Failed to wipe business data."));
  }
};

/**
 * Factory Reset (Delete Everything)
 */
exports.factoryReset = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    // 1. Clear All Business Data
    await clearCollection(Sale, session);
    await clearCollection(Invoice, session);
    await clearCollection(LC, session);
    await clearCollection(Product, session);
    await clearCollection(Category, session);
    await clearCollection(Unit, session);
    await clearCollection(Warehouse, session);
    await clearCollection(Customer, session);
    await clearCollection(Account, session);
    await clearCollection(Transaction, session);
    await clearCollection(DailyCash, session);
    await clearCollection(Trash, session);

    // 2. Clear System Settings
    await clearCollection(SystemSettings, session);

    // 3. Clear Users (Except maybe the one requesting? Or full wipe?)
    // User requested "clear whole data including the super admin/users".
    // This effectively kills the current session and token authenticity for subsequent requests.
    await clearCollection(User, session);

    await session.commitTransaction();
    session.endSession();

    logger.warn(`FACORY RESET performed by ${req.user.email}`);

    auditService.log({
      action: "WIPE",
      module: "System",
      userId: req.user?._id,
      description: `Performed factory reset — all data deleted`,
      req,
    });

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          null,
          "Factory Reset Complete. The system is now empty. You will be logged out.",
        ),
      );
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    next(new ApiError(500, "Factory reset failed."));
  }
};
