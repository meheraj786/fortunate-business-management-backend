const mongoose = require("mongoose");
const mongoosePaginate = require("mongoose-paginate-v2");

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
  date: { type: Date, required: true },
  method: {
    type: String,
    enum: ["Cash", "Bank", "Mobile Banking", "Customer Credit"],
    required: true,
  },
  accountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Account",
    required: function () {
      return ["Bank", "Mobile Banking", "Cash"].includes(this.method);
    },
  },
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
    costs: [costSchema],
    charges: [chargeSchema],
    discount: { type: Number, default: 0 },
    totalAmountToBePaid: { type: Number, required: true },
    invoiceStatus: {
      type: String,
      enum: ["Not-invoiced", "Invoiced", "Cancelled"],
      default: "Not-invoiced",
    },
    paymentStatus: {
      type: String,
      enum: ["Paid payment", "Due payment", "N/A"],
      default: "N/A",
    },
    payments: [paymentSchema],
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
  { timestamps: true },
);

salesSchema.plugin(mongoosePaginate);

/*
 * Pre-save hook for amount calculations.
 *
 * 1. `totalAmount` is calculated as `quantity * pricePerUnit`.
 * 2. `totalAmountToBePaid` is calculated based on totalAmount, charges, costs, and discount.
 */
salesSchema.pre("validate", function (next) {
  // Calculate total amount from items
  if (this.items && this.items.length > 0) {
    this.totalAmount = this.items.reduce((sum, item) => {
      // Ensure item total is correct
      item.total = item.quantity * item.pricePerUnit;
      return sum + item.total;
    }, 0);
  } else {
    this.totalAmount = 0;
  }

  const costsTotal = this.costs.reduce((acc, cost) => acc + cost.amount, 0);
  const chargesTotal = this.charges.reduce(
    (acc, charge) => acc + charge.amount,
    0,
  );
  this.totalAmountToBePaid =
    this.totalAmount + chargesTotal + costsTotal - this.discount;

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
      (acc, payment) => acc + payment.amount,
      0,
    );
    if (totalPaid >= this.totalAmountToBePaid) {
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
salesSchema.index({ saleDate: -1 });
salesSchema.index({ totalAmountToBePaid: 1 });

// Additional indexes for common query patterns
salesSchema.index({ warehouse: 1, isDeleted: 1 });
salesSchema.index({ paymentStatus: 1, isDeleted: 1 });
salesSchema.index({ createdAt: -1 });

const Sale = mongoose.model("Sale", salesSchema);
module.exports = Sale;
