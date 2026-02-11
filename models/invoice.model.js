const mongoose = require("mongoose");

/*
 * Cost Sub-schema
 * Represents additional costs associated with a sale, such as loading or delivery charges.
 */
const costSchema = new mongoose.Schema({
  name: { type: String, required: true },
  amount: { type: Number, required: true },
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

const invoiceSchema = new mongoose.Schema(
  {
    invoiceId: {
      type: String,
      required: true,
      unique: true,
    },
    salesId: {
      type: String,
      ref: "Sales",
      required: true,
    },
    invoiceGeneratedDate: {
      type: Date,
      default: Date.now,
    },
    salesDate: {
      type: Date,
      required: true,
    },
    items: [
      {
        productId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Product",
          required: true,
        },
        name: { type: String, required: true },
        category: { type: String, required: true },
        quantity: { type: Number, required: true },
        unit: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Unit",
          required: true,
        },
        unitName: { type: String }, // Storing name for historical accuracy
        pricePerUnit: { type: Number, required: true },
        total: { type: Number, required: true },
      },
    ],
    customerDetails: {
      customerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Customer",
        default: null,
      },
      name: { type: String, required: true },
      phone: { type: String },
      address: { type: String },
    },
    paymentAndAmountInfo: {
      totalAmount: { type: Number, required: true },
      costs: [costSchema],
      charges: [chargeSchema],
      discount: { type: Number, default: 0 },
      totalAmountToBePaid: { type: Number, required: true },
      paymentStatus: {
        type: String,
        enum: ["Paid payment", "Due payment"],
      },
      payments: [paymentSchema],
      paymentsMade: { type: Number, required: true },
      balanceDue: { type: Number, required: true },
      overPayment: { type: Number, required: true },
    },
    notes: { type: String, trim: true },
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
  },
  { timestamps: true },
);

const Invoice = mongoose.model("Invoice", invoiceSchema);
module.exports = Invoice;
