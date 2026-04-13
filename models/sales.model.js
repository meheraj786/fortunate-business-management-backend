const mongoose = require("mongoose");
const mongoosePaginate = require("mongoose-paginate-v2");
const mathUtil = require("../utils/math.util");

/*
 * Cost Sub-schema
 * Represents additional costs associated with a sale, such as loading or delivery charges.
 */
const costSchema = new mongoose.Schema({
  name: { type: String, required: true },
  amount: { type: Number, required: true },
  date: { type: Date, required: true },
  accountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Account",
    required: true,
  },
  paymentMethod: {
    type: String,
    required: true,
    enum: ["Cash", "Bank", "Mobile Banking"],
  },
});

/*
 * Charge Sub-schema
 * Represents additional charges to the customer for a sale, like service fees, that aren't direct business costs.
 */
const chargeSchema = new mongoose.Schema({
  name: { type: String, required: true },
  amount: { type: Number, required: true },
});

/*
 * Payment Sub-schema
 * Represents a payment made for a sale, including partial payments.
 */
const paymentSchema = new mongoose.Schema({
  amount: { type: Number, required: true },
  discount: { type: Number, default: 0 },
  date: { type: Date, required: true },
  method: {
    type: String,
    enum: ["Cash", "Bank", "Mobile Banking", "Customer Credit", "Discount"],
    required: function () {
      return this.amount > 0; // Method only required for actual payments, not discount-only entries
    },
  },
  accountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Account",
    required: function () {
      return this.amount > 0 && ["Bank", "Mobile Banking", "Cash"].includes(this.method);
    },
  },
  isReversed: { type: Boolean, default: false },
  reversedAt: { type: Date },
  reversedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
});

/*
 * Main Sales Schema
 */
/*
 * Sale Item Sub-schema
 * Represents an individual item within a sale.
 */
const saleItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Product",
    required: true,
  },
  quantity: { type: Number, required: true, min: 0 },
  unit: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Unit",
    required: true,
  },
  pricePerUnit: { type: Number, required: true, min: 0 },
  total: { type: Number, required: true, min: 0 },
  remark: { type: String, default: "" },
});

/*
 * Main Sales Schema
 */
const salesSchema = new mongoose.Schema(
  {
    saleId: { type: String, required: true, unique: true, trim: true },
    items: [saleItemSchema], // Replaces separate product, quantity, unit, pricePerUnit
    customer: {
      customerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Customer",
        default: null,
      },
      name: { type: String, required: true },
      phone: { type: String },
      address: { type: String },
    },
    warehouse: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Warehouse",
      required: function () {
        return this.saleId && !this.saleId.startsWith("OPEN-BAL-");
      },
    },
    category: { // Kept for high-level filtering/stats, typically represents the main category of the sale or first item's category
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
    },
    totalAmount: { type: Number, required: true },
    costs: {
      type: [costSchema],
      validate: [arr => arr.length <= 90, "Cannot have more than 50 cost entries"],
    },
    charges: {
      type: [chargeSchema],
      validate: [arr => arr.length <= 90, "Cannot have more than 50 charge entries"],
    },
    discount: { type: Number, default: 0 },
    totalAmountToBePaid: { type: Number, required: true },
    invoiceStatus: {
      type: String,
      enum: ["Not-invoiced", "Invoiced", "Cancelled"],
      default: "Not-invoiced",
    },
    paymentStatus: {
      type: String,
      // "Paid payment" etc. are legacy strings. We can keep them or migrate.
      // Let's stick to the plan but support legacy for now if needed, or just migrate all data.
      // PROPOSAL: Use cleaner enums. "Paid", "Partial", "Due", "Overpaid".
      enum: ["Paid", "Partial", "Due", "Paid payment", "Due payment", "N/A"],
      default: "Due",
      index: true, // Compound index at {paymentStatus, isDeleted} covers queries
    },
    // --- Persisted Financial Fields ---
    totalPaid: { type: Number, default: 0, index: true },
    balanceDue: { type: Number, default: 0, index: true },
    // ----------------------------------
    payments: {
      type: [paymentSchema],
      validate: [arr => arr.length <= 100, "Cannot have more than 100 payment entries"],
    },
    notes: { type: String, trim: true },
    saleDate: { type: Date, default: Date.now },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    modifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true, optimisticConcurrency: true },
);

salesSchema.plugin(mongoosePaginate);

/*
 * Pre-save hook for amount calculations.
 *
 * 1. `totalAmount` is calculated as `quantity * pricePerUnit`.
 * 2. `totalAmountToBePaid` is calculated based on totalAmount, charges, costs, and discount.
 */
salesSchema.pre("validate", function (next) {
  // Calculate total amount from items, except for opening balance sales
  if (this.saleId && this.saleId.startsWith("OPEN-BAL-")) {
    // Preserve the manually set totalAmount
  } else if (this.items && this.items.length > 0) {
    this.totalAmount = this.items.reduce((sum, item) => {
      // Ensure item total is correct
      item.total = mathUtil.mul(item.quantity, item.pricePerUnit);
      return mathUtil.add(sum, item.total);
    }, 0);
  } else {
    this.totalAmount = 0;
  }

  const costsTotal = this.costs.reduce((acc, cost) => mathUtil.add(acc, cost.amount), 0);
  const chargesTotal = this.charges.reduce(
    (acc, charge) => mathUtil.add(acc, charge.amount),
    0,
  );

  // totalAmountToBePaid = totalAmount + charges + costs - discount
  // We round at the end to ensure 2 decimal places
  const subTotal = mathUtil.add(this.totalAmount, mathUtil.add(chargesTotal, costsTotal));
  const finalAmount = mathUtil.sub(subTotal, this.discount);

  this.totalAmountToBePaid = mathUtil.round(finalAmount);
  this.totalAmount = mathUtil.round(this.totalAmount);

  next();
});

/*
 * Pre-save hook for payment status calculation.
 *
 * 1. If `invoiceStatus` is "Invoiced":
 *    a. Calculate the total paid amount from the `payments` array.
 *    b. If `totalPaid` is greater than or equal to `totalAmountToBePaid`, set `paymentStatus` to "Paid payment".
 *    c. Otherwise, set `paymentStatus` to "Due payment".
 * 2. If `invoiceStatus` is not "Invoiced", remove the `paymentStatus`.
 */
salesSchema.pre("save", function (next) {
  if (this.invoiceStatus === "Invoiced") {
    const totalPaid = this.payments.reduce(
      (acc, payment) => mathUtil.add(acc, payment.amount),
      0,
    );
    // Fix floating point precision issues (e.g. 179.2 vs 179.20000000000002)
    // We consider it paid if the difference is non-existent or tiny (handled by round/sub)
    // Using mathUtil.sub to check difference
    const diff = mathUtil.sub(this.totalAmountToBePaid, totalPaid);

    // If diff <= 0.001 (allowing for negligible rounding artifacts if any, though decimal.js should match exact), 
    // it is Paid.
    if (diff <= 0.001) {
      this.paymentStatus = "Paid payment";
    } else {
      this.paymentStatus = "Due payment";
    }
  } else {
    this.paymentStatus = undefined;
  }
  next();
});

// Indexes for performance
salesSchema.index({ isDeleted: 1, saleDate: -1 });
salesSchema.index({ invoiceStatus: 1, isDeleted: 1 });
salesSchema.index({ "items.product": 1 });
salesSchema.index({ "customer.customerId": 1 });
salesSchema.index({ "customer.name": 1 });
// Note: standalone { saleDate: -1 } removed — covered by { isDeleted: 1, saleDate: -1 }
salesSchema.index({ totalAmountToBePaid: 1 });

// Additional indexes for common query patterns
salesSchema.index({ warehouse: 1, isDeleted: 1 });
salesSchema.index({ paymentStatus: 1, isDeleted: 1 });
salesSchema.index({ createdAt: -1 });

const Sale = mongoose.model("Sale", salesSchema);
module.exports = Sale;
