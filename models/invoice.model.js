const mongoose = require("mongoose");

const otherChargeSchema = new mongoose.Schema({
  name: { type: String, required: true },
  amount: { type: Number, required: true },
});

const paymentSchema = new mongoose.Schema({
  amount: { type: Number, required: true },
  date: { type: Date, required: true },
  method: {
    type: String,
    enum: ["cash", "bank", "mobile-banking"],
    required: true,
  },
});

const invoiceSchema = new mongoose.Schema(
  {
    salesId: {
      type: mongoose.Schema.Types.ObjectId,
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
    productDetails: {
      productId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Product",
        required: true,
      },
      name: { type: String, required: true },
      category: { type: String, required: true },
      quantity: { type: Number, required: true },
      unit: { type: mongoose.Schema.Types.ObjectId, ref: "Unit", required: true },
      pricePerUnit: { type: Number, required: true },
    },
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
      deliveryCharge: { type: Number, default: 0 },
      otherCharges: [otherChargeSchema],
      discount: { type: Number, default: 0 },
      totalAmountToBePaid: { type: Number, required: true },
      paymentStatus: {
        type: String,
        enum: ["Paid payment", "Due payment"],
      },
      payments: [paymentSchema],
    },
    notes: { type: String, trim: true },
  },
  { timestamps: true }
);

const Invoice = mongoose.model("Invoice", invoiceSchema);
module.exports = Invoice;
