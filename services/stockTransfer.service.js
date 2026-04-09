const mongoose = require("mongoose");
const Product = require("../models/product.model");
const Warehouse = require("../models/warehouse.model");
const { ApiError } = require("../utils/ApiError");
const auditService = require("./audit.service");

/**
 * Stock Transfer Service
 *
 * Handles transferring products between warehouses — both full and partial transfers.
 * All operations run inside a MongoDB transaction for atomicity.
 */

/**
 * Transfer stock from one warehouse to another.
 *
 * @param {Object} params
 * @param {string} params.productId        - Source product ID
 * @param {string} params.sourceWarehouseId - Source warehouse ID (current product location)
 * @param {string} params.destinationWarehouseId - Destination warehouse ID
 * @param {string} params.transferType     - "full" or "partial"
 * @param {number} [params.quantity]       - Quantity to transfer (required for partial)
 * @param {string} [params.notes]          - Optional reason/notes for audit
 * @param {string} params.userId           - User performing the transfer
 * @param {Object} [params.req]            - Express request (for audit IP)
 * @returns {Promise<Object>} - { sourceProduct, destinationProduct?, transferType }
 */
const transferStock = async ({
  productId,
  sourceWarehouseId,
  destinationWarehouseId,
  transferType,
  quantity,
  notes,
  userId,
  req,
}) => {
  // --- Pre-flight Validations (outside transaction for fast-fail) ---
  if (!productId) throw new ApiError(400, "Product ID is required.");
  if (!sourceWarehouseId) throw new ApiError(400, "Source warehouse ID is required.");
  if (!destinationWarehouseId) throw new ApiError(400, "Destination warehouse ID is required.");
  if (!["full", "partial"].includes(transferType)) {
    throw new ApiError(400, "Transfer type must be 'full' or 'partial'.");
  }

  if (sourceWarehouseId === destinationWarehouseId) {
    throw new ApiError(400, "Source and destination warehouses must be different.");
  }

  if (transferType === "partial") {
    if (quantity === undefined || quantity === null || quantity <= 0) {
      throw new ApiError(400, "Quantity must be greater than zero for partial transfers.");
    }
  }

  // --- Start Transaction ---
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // 1. Fetch and validate source product
    const sourceProduct = await Product.findOne({
      _id: productId,
      warehouse: sourceWarehouseId,
      isDeleted: { $ne: true },
    }).session(session);

    if (!sourceProduct) {
      throw new ApiError(404, "Product not found in the source warehouse.");
    }

    if (sourceProduct.lotClosed) {
      throw new ApiError(400, "Cannot transfer a product whose lot has been closed.");
    }

    if (sourceProduct.quantity <= 0) {
      throw new ApiError(400, "Cannot transfer a product with zero stock.");
    }

    // 2. Validate warehouses exist
    const [sourceWarehouse, destinationWarehouse] = await Promise.all([
      Warehouse.findOne({ _id: sourceWarehouseId, isDeleted: { $ne: true } }).session(session),
      Warehouse.findOne({ _id: destinationWarehouseId, isDeleted: { $ne: true } }).session(session),
    ]);

    if (!sourceWarehouse) throw new ApiError(404, "Source warehouse not found.");
    if (!destinationWarehouse) throw new ApiError(404, "Destination warehouse not found.");

    // 3. Validate quantity for partial transfer
    if (transferType === "partial" && quantity >= sourceProduct.quantity) {
      throw new ApiError(
        400,
        `Cannot partially transfer ${quantity} — product only has ${sourceProduct.quantity} in stock. Use a full transfer instead.`,
      );
    }

    let result;

    if (transferType === "full") {
      result = await executeFullTransfer({
        sourceProduct,
        sourceWarehouse,
        destinationWarehouse,
        session,
      });
    } else {
      result = await executePartialTransfer({
        sourceProduct,
        sourceWarehouse,
        destinationWarehouse,
        quantity,
        session,
      });
    }

    // 4. Commit transaction
    await session.commitTransaction();
    session.endSession();

    // 5. Audit Log (fire-and-forget, outside transaction)
    const auditDescription =
      transferType === "full"
        ? `Full transfer of product "${sourceProduct.name}" (${sourceProduct.quantity} ${result.unitName || "units"}) from "${sourceWarehouse.name}" to "${destinationWarehouse.name}"`
        : `Partial transfer of ${quantity} ${result.unitName || "units"} of "${sourceProduct.name}" from "${sourceWarehouse.name}" to "${destinationWarehouse.name}"`;

    auditService.log({
      action: "TRANSFER",
      module: "StockTransfer",
      documentId: sourceProduct._id,
      userId,
      description: auditDescription,
      changes: {
        before: {
          warehouse: sourceWarehouse.name,
          quantity: transferType === "full" ? sourceProduct.quantity : sourceProduct.quantity,
        },
        after: {
          warehouse: destinationWarehouse.name,
          quantity: transferType === "full" ? sourceProduct.quantity : quantity,
          sourceRemainingQuantity: transferType === "partial" ? result.sourceProduct.quantity : 0,
        },
      },
      metadata: {
        transferType,
        sourceWarehouseId,
        destinationWarehouseId,
        sourceWarehouseName: sourceWarehouse.name,
        destinationWarehouseName: destinationWarehouse.name,
        transferredQuantity: transferType === "full" ? sourceProduct.quantity : quantity,
        notes: notes || null,
        ...(result.destinationProduct
          ? { newProductId: result.destinationProduct._id }
          : {}),
      },
      req,
    });

    return {
      transferType,
      sourceProduct: result.sourceProduct,
      destinationProduct: result.destinationProduct || null,
      sourceWarehouse: { _id: sourceWarehouse._id, name: sourceWarehouse.name },
      destinationWarehouse: { _id: destinationWarehouse._id, name: destinationWarehouse.name },
    };
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
};

/**
 * Executes a full transfer — moves the entire product to the destination warehouse.
 */
async function executeFullTransfer({
  sourceProduct,
  sourceWarehouse,
  destinationWarehouse,
  session,
}) {
  // 1. Remove product ref from source warehouse
  await Warehouse.updateOne(
    { _id: sourceWarehouse._id },
    { $pull: { product: sourceProduct._id } },
    { session },
  );

  // 2. Update product's warehouse reference
  sourceProduct.warehouse = destinationWarehouse._id;
  await sourceProduct.save({ session });

  // 3. Add product ref to destination warehouse
  await Warehouse.updateOne(
    { _id: destinationWarehouse._id },
    { $addToSet: { product: sourceProduct._id } },
    { session },
  );

  // Fetch unit name for audit
  const populatedProduct = await Product.findById(sourceProduct._id)
    .populate("unit", "name")
    .session(session)
    .lean();

  return {
    sourceProduct: sourceProduct,
    destinationProduct: null, // Same product, just moved
    unitName: populatedProduct?.unit?.name || "units",
  };
}

/**
 * Executes a partial transfer — creates a new product in destination with the transferred quantity.
 */
async function executePartialTransfer({
  sourceProduct,
  sourceWarehouse,
  destinationWarehouse,
  quantity,
  session,
}) {
  // 1. Atomically deduct quantity from source product (with guard)
  const updatedSource = await Product.findOneAndUpdate(
    {
      _id: sourceProduct._id,
      isDeleted: { $ne: true },
      quantity: { $gte: quantity }, // Atomic guard — prevents going negative
    },
    {
      $inc: { quantity: -quantity },
    },
    { new: true, session },
  );

  if (!updatedSource) {
    throw new ApiError(
      400,
      "Insufficient stock for transfer. Another operation may have changed the quantity. Please refresh and try again.",
    );
  }

  // 2. Create new product in destination warehouse with transferred quantity
  const newProductData = {
    name: sourceProduct.name,
    productDescription: sourceProduct.productDescription,
    category: sourceProduct.category,
    LC: sourceProduct.LC || undefined,
    supplierName: sourceProduct.supplierName,
    thickness: sourceProduct.thickness,
    width: sourceProduct.width,
    length: sourceProduct.length,
    color: sourceProduct.color,
    grade: sourceProduct.grade,
    quantity: quantity,
    unit: sourceProduct.unit,
    unitPrice: sourceProduct.unitPrice,
    warehouse: destinationWarehouse._id,
  };

  // Remove undefined fields to avoid Mongoose validation issues
  Object.keys(newProductData).forEach(
    (key) => newProductData[key] === undefined && delete newProductData[key],
  );

  const [newProduct] = await Product.create([newProductData], { session });

  // 3. Add new product ref to destination warehouse
  await Warehouse.updateOne(
    { _id: destinationWarehouse._id },
    { $addToSet: { product: newProduct._id } },
    { session },
  );

  // Fetch unit name for audit
  const populatedProduct = await Product.findById(sourceProduct._id)
    .populate("unit", "name")
    .session(session)
    .lean();

  return {
    sourceProduct: updatedSource,
    destinationProduct: newProduct,
    unitName: populatedProduct?.unit?.name || "units",
  };
}

module.exports = {
  transferStock,
};
