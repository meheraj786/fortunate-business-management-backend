const mongoose = require("mongoose");

/*
 * Other Charges Sub-schema
 * Represents additional charges associated with a sale, such as loading charges.
 */
const otherChargeSchema = new mongoose.Schema({
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
  method: { type: String, enum: ["cash", "bank", "mobile-banking"], required: true },
});

/*
 * Main Sales Schema
 */
const salesSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    /*
     * Customer Information
     * For existing customers, `customerId` will be populated along with their details.
     * For manual (temporary) customers, `name`, `phone`, and `address` will be populated,
     * and `customerId` will be null.
     */
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
      required: true,
    },
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: true,
    },
    quantity: { type: Number, required: true, min: 0 },
    unit: { type: String, trim: true, required: true },
    pricePerUnit: { type: Number, required: true, min: 0 },
    totalAmount: { type: Number, required: true },
    deliveryCharge: { type: Number, default: 0 },
    otherCharges: [otherChargeSchema],
    discount: { type: Number, default: 0 },
    totalAmountToBePaid: { type: Number, required: true },
    invoiceStatus: { type: String, enum: ["Invoiced", "Not Invoiced"], default: "Not Invoiced" },
    paymentStatus: {
      type: String,
      enum: ["Due Payment", "Paid Payment", "N/A"],
      default: "N/A",
    },
    payments: [paymentSchema],
    notes: { type: String, trim: true },
    saleDate: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

/*
 * Pre-save hook for amount calculations.
 *
 * 1. `totalAmount` is calculated as `quantity * pricePerUnit`.
 * 2. `totalAmountToBePaid` is calculated based on totalAmount, deliveryCharge, otherCharges, and discount.
 */
salesSchema.pre("validate", function (next) {
  this.totalAmount = this.quantity * this.pricePerUnit;
  const otherChargesTotal = this.otherCharges.reduce((acc, charge) => acc + charge.amount, 0);
  this.totalAmountToBePaid = this.totalAmount + this.deliveryCharge + otherChargesTotal - this.discount;

  next();
});

// Indexes for performance
salesSchema.index({ product: 1 });
salesSchema.index({ "customer.customerId": 1 });
salesSchema.index({ "customer.name": 1 });
salesSchema.index({ saleDate: -1 });

const Sales = mongoose.model("Sales", salesSchema);
module.exports = Sales;