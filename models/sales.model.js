const mongoose = require("mongoose");
const mongoosePaginate = require("mongoose-paginate-v2");

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
    enum: ["Cash", "Bank", "Mobile Banking"],
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
const salesSchema = new mongoose.Schema(
  {
    saleId: { type: String, required: true, unique: true, trim: true },
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
    unit: { type: mongoose.Schema.Types.ObjectId, ref: "Unit", required: true },
    pricePerUnit: { type: Number, required: true, min: 0 },
    totalAmount: { type: Number, required: true },
    costs: [costSchema], 
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
  }
  },
  { timestamps: true }
);

salesSchema.plugin(mongoosePaginate);

/*
 * Pre-save hook for amount calculations.
 *
 * 1. `totalAmount` is calculated as `quantity * pricePerUnit`.
 * 2. `totalAmountToBePaid` is calculated based on totalAmount, costs, and discount.
 */
salesSchema.pre("validate", function (next) {
  this.totalAmount = this.quantity * this.pricePerUnit;
  const costsTotal = this.costs.reduce(
    (acc, cost) => acc + cost.amount,
    0
  );
  this.totalAmountToBePaid =
    this.totalAmount + costsTotal - this.discount;

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
      0
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
salesSchema.index({ product: 1 });
salesSchema.index({ "customer.customerId": 1 });
salesSchema.index({ "customer.name": 1 });
salesSchema.index({ saleDate: -1 });
salesSchema.index({ totalAmountToBePaid: 1 });

const Sale = mongoose.model("Sale", salesSchema);
module.exports = Sale;
