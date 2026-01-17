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
exports.validateSaleDate = (saleDate) => {
  if (!saleDate) return;
  const today = startOfDay(now());
  const providedSaleDate = startOfDay(new Date(saleDate));

  if (providedSaleDate > today) {
    throw new ApiError(400, "Sale date cannot be in the future.");
  }
};

/**
 * Checks if stock is available and validates unit compatibility
 * Returns the calculated quantity to deduct from product stock
 */
exports.validateStockAndGetDeduction = async (
  productId,
  quantity,
  unitId,
  session,
) => {
  const sellingProduct = await Product.findById(productId)
    .session(session)
    .populate("unit");
  if (!sellingProduct) {
    throw new ApiError(400, "Product not found");
  }

  const saleUnit = await Unit.findById(unitId).session(session);
  if (!saleUnit) {
    throw new ApiError(400, "Sale unit not found");
  }

  // Check if units are compatible (same type)
  if (sellingProduct.unit.type !== saleUnit.type) {
    throw new ApiError(
      400,
      `Cannot sell product. Incompatible units: Product is in '${sellingProduct.unit.type}' while sale is in '${saleUnit.type}'.`,
    );
  }

  // Calculate details in base unit (avoiding floating point errors where possible by logic, though JS numbers are floats)
  const saleQuantityInBaseUnit = quantity * saleUnit.conversionFactor;
  const productStockInBaseUnit =
    sellingProduct.quantity * sellingProduct.unit.conversionFactor;

  if (productStockInBaseUnit < saleQuantityInBaseUnit) {
    throw new ApiError(400, "Not enough product in stock");
  }

  // Calculate the actual quantity to deduct from the product's stock (in its own unit)
  const quantityToDeductFromProduct =
    saleQuantityInBaseUnit / sellingProduct.unit.conversionFactor;

  return { quantityToDeductFromProduct, sellingProduct, saleUnit };
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
  const existingCustomer = await Customer.findById(customerId).session(session);

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
