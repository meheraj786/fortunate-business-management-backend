const Sales = require("../models/sales.model");
const Product = require("../models/product.model");
const Customer = require("../models/customer.model");
const Unit = require("../models/unit.model");
const { ApiError } = require("../utils/ApiError");
const { startOfDay, now } = require("../utils/timezone.util");

/**
 * Generates a new sequential Sale ID (e.g., SALE-24-000001)
 */
exports.generateSaleId = async () => {
  const currentYear = new Date().getFullYear();
  const shortYear = currentYear.toString().slice(-2);

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

  return `SALE-${shortYear}-${(lastSaleIdNumber + 1)
    .toString()
    .padStart(6, "0")}`;
};

/**
 * Validates that the sale date is not in the future
 */
exports.validateSaleDate = (saleDate, timezone) => {
  if (!saleDate) return;
  const today = startOfDay(now(), timezone);
  const providedSaleDate = startOfDay(new Date(saleDate), timezone);

  if (providedSaleDate > today) {
    throw new ApiError(400, "Sale date cannot be in the future.");
  }
};

/**
 * Checks if stock is available and validates unit compatibility for multiple items
 * Returns a list of deductions to be applied
 */
exports.validateStockForItems = async (items, warehouseId, session) => {
  const deductions = [];
  const productQuantities = new Map(); // productId -> { baseUnitRequests: [] }

  // 1. Aggregation Pass
  for (const item of items) {
    const { product: productId, quantity, unit: unitId } = item;

    // Fetch unit to get conversion factor
    const saleUnit = await Unit.findById(unitId).session(session);
    if (!saleUnit) {
      throw new ApiError(400, `Unit not found for product ${productId}`);
    }

    let currentTotal = productQuantities.get(productId.toString());
    if (!currentTotal) {
      currentTotal = { baseUnitRequests: [] };
      productQuantities.set(productId.toString(), currentTotal);
    }

    // Store instruction
    currentTotal.baseUnitRequests.push({
      quantity,
      conversionFactor: saleUnit.conversionFactor,
      unitType: saleUnit.type,
      unitId,
      unitName: saleUnit.name
    });
  }

  // 2. Validation Pass
  for (const [productId, data] of productQuantities.entries()) {
    const sellingProduct = await Product.findOne({
      _id: productId,
      isDeleted: { $ne: true },
    })
      .session(session)
      .populate("unit");

    if (!sellingProduct) {
      throw new ApiError(400, `Product not found: ${productId}`);
    }

    // --- Warehouse Consistency Check ---
    if (sellingProduct.warehouse.toString() !== warehouseId.toString()) {
      throw new ApiError(
        400,
        `Product '${sellingProduct.name}' does not belong to the selected warehouse.`
      );
    }

    let totalBaseUnitRequired = 0;

    for (const req of data.baseUnitRequests) {
      // Check Type Compatibility
      if (sellingProduct.unit.type !== req.unitType) {
        throw new ApiError(
          400,
          `Incompatible units for product '${sellingProduct.name}'. Product is in '${sellingProduct.unit.type}' but sale item is in '${req.unitType}'.`
        );
      }
      totalBaseUnitRequired += req.quantity * req.conversionFactor;
    }

    const productStockInBaseUnit = sellingProduct.quantity * sellingProduct.unit.conversionFactor;

    if (productStockInBaseUnit < totalBaseUnitRequired) {
      // Calculate max qty in the *last requested unit* for better error message, 
      // or just use base unit. Let's use the first requested unit's name for clarity if possible.
      const displayUnitName = data.baseUnitRequests[0].unitName;
      const displayConversion = data.baseUnitRequests[0].conversionFactor;

      throw new ApiError(
        400,
        `Not enough stock for product '${sellingProduct.name}'. Requested: ${(totalBaseUnitRequired / displayConversion).toFixed(2)} ${displayUnitName} (Available: ${(productStockInBaseUnit / displayConversion).toFixed(2)} ${displayUnitName})`
      );
    }

    // Calculate deduction in Product's Native Unit
    const quantityToDeductFromProduct = totalBaseUnitRequired / sellingProduct.unit.conversionFactor;
    deductions.push({ productId, quantityToDeductFromProduct });
  }

  return deductions;
};

/**
 * Checks if adding this sale exceeds the customer's credit limit
 */
exports.checkCustomerCreditLimit = async (
  customerId,
  saleFinancials,
  session,
) => {
  // saleFinancials: { totalAmount, costsTotal, chargesTotal, discount, totalPaid }
  const existingCustomer = await Customer.findOne({
    _id: customerId,
    isDeleted: { $ne: true },
  }).session(session);

  if (!existingCustomer) {
    throw new ApiError(400, "Customer not found");
  }

  const { totalAmount, costsTotal, chargesTotal, discount, totalPaid } =
    saleFinancials;
  const prospectiveTotal = totalAmount + costsTotal + chargesTotal - discount;
  const newSaleDueAmount = prospectiveTotal - totalPaid;

  // Only check if there is a due amount
  if (newSaleDueAmount > 0) {
    const salesPipeline = [
      {
        $match: {
          "customer.customerId": existingCustomer._id,
          isDeleted: { $ne: true },
          paymentStatus: "Due payment",
        },
      },
      {
        $group: {
          _id: null,
          totalDue: {
            $sum: {
              $subtract: ["$totalAmountToBePaid", { $sum: "$payments.amount" }],
            },
          },
        },
      },
    ];

    const result = await Sales.aggregate(salesPipeline).session(session);
    const currentDues = result.length > 0 ? result[0].totalDue : 0;

    if (currentDues + newSaleDueAmount > existingCustomer.creditLimit) {
      throw new ApiError(
        409,
        `Cannot create sale. This transaction exceeds the customer's credit limit of ${existingCustomer.creditLimit}. Current outstanding due is ${currentDues}.`,
      );
    }
  }
  return existingCustomer;
};

/**
 * Calculates the difference between old and new items to determine stock adjustments.
 * Returns a list of actions: { productId, quantityChange, type: 'deduct' | 'restore' }
 * quantityChange is always positive in the product's native unit.
 */
exports.calculateStockDiff = async (oldItems, newItems, session) => {
  const stockActions = [];
  const productMap = new Map();

  // 1. Map Old Items (Restore Logic)
  // We initially assume we "restore" everything, then we subtract what is kept/added.
  // Or better: Calculate Net Change per Product.

  // Let's use a Net Base Unit Change approach per Product ID.
  // Positive Net = We need MORE stock (Deduct from DB)
  // Negative Net = We return stock (Restore to DB)

  // Map: productId -> netBaseQuantityRequired

  for (const item of oldItems) {
    if (!item.product) continue;
    const productId = item.product._id || item.product;
    const qty = item.quantity || 0;

    // existing item might have unit populated or not. 
    // If populated, use it. If not, we might need to fetch it? 
    // Ideally oldItems come from a populated sale query.
    // We'll assume caller provides populated items or we fetch.
    // For robust server-side logic, we should probably fetch to be 100% sure of conversion factors?
    // BUT fetching everything again is expensive.
    // Let's assume standard populated structure: item.unit is an object with conversionFactor.

    const conversionFactor = item.unit?.conversionFactor || 1;
    const baseQty = qty * conversionFactor;

    const current = productMap.get(productId.toString()) || 0;
    productMap.set(productId.toString(), current - baseQty); // We "have" this, so valid demand is negative (already taken)
    // Wait, let's think:
    // Net Change = New Demand - Old Demand
    // If Net Change > 0: Deduct Stock
    // If Net Change < 0: Restore Stock

    // So Old Demand is what we currently hold.
    // productMap value will represent "New Demand". 
    // So start with NEGATIVE Old Demand? 
    // No, let's track "Net Required".
    // Initial State: We have taken X. 
    // If we want Y. Net = Y - X.

    productMap.set(productId.toString(), current - baseQty);
  }

  for (const item of newItems) {
    if (!item.product) continue;
    const productId = item.product; // newItems usually have raw IDs
    const qty = parseFloat(item.quantity) || 0;

    // We need the unit's conversion factor for the NEW item.
    // The frontend sends unit ID. We must fetch it.
    const unit = await Unit.findById(item.unit).session(session);
    if (!unit) throw new ApiError(400, `Unit not found for product ${productId}`);

    const baseQty = qty * unit.conversionFactor;

    const current = productMap.get(productId.toString()) || 0;
    productMap.set(productId.toString(), current + baseQty);
  }

  // Now process the map
  for (const [productId, netBaseQty] of productMap.entries()) {
    if (netBaseQty === 0) continue;

    const product = await Product.findById(productId).session(session).populate('unit');
    if (!product) throw new ApiError(404, `Product not found: ${productId}`);

    const nativeQtyChange = Math.abs(netBaseQty) / product.unit.conversionFactor;

    if (netBaseQty > 0) {
      // Need MORE -> Deduct
      // Verify Stock Availability
      if (product.quantity < nativeQtyChange) {
        throw new ApiError(400, `Insufficient stock for '${product.name}'. Required additional: ${nativeQtyChange.toFixed(3)} ${product.unit.name}, Available: ${product.quantity.toFixed(3)} ${product.unit.name}`);
      }
      stockActions.push({
        productId,
        quantity: nativeQtyChange,
        type: 'deduct'
      });
    } else {
      // Need LESS -> Restore
      stockActions.push({
        productId,
        quantity: nativeQtyChange,
        type: 'restore'
      });
    }
  }

  return stockActions;
};

/**
 * Applies the calculated stock actions.
 */
exports.applyStockDiff = async (actions, session) => {
  for (const action of actions) {
    const adjustment = action.type === 'deduct' ? -action.quantity : action.quantity;

    await Product.findByIdAndUpdate(
      action.productId,
      { $inc: { quantity: adjustment } },
      { session, new: true }
    );
  };
};
