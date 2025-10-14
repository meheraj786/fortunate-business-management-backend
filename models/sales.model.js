const mongoose = require("mongoose");

const salesSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
    },
    lcNumber: { type: String, trim: true }, 
    quantity: { type: Number, required: true, min: 0 },
    price: { type: Number, required: true, min: 0 },
    totalAmount: { type: Number }, 
    unit: { type: String, trim: true, required: true },
    category: { type: String, trim: true },
    size: { type: String, trim: true },
    invoiceStatus: { type: String, enum: ["yes", "no"], default: "no" },
    date: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

salesSchema.pre("save", function (next) {
  this.totalAmount = this.quantity * this.price;
  next();
});

salesSchema.index({ product: 1 });
salesSchema.index({ customer: 1 });
salesSchema.index({ date: 1 });

const Sales = mongoose.model("Sales", salesSchema);
module.exports = Sales;
