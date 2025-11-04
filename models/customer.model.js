const mongoose = require("mongoose");
const { Schema } = mongoose;

const documentSchema = new Schema({
  name: { type: String, required: true },
  type: { type: String, required: true },
  size: { type: String, required: true },
  uploadDate: { type: Date, default: Date.now },
});

const customerSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    companyName: { type: String, trim: true },
    phone: {
      type: String,
      trim: true,
      required: true,
      unique: true,
    },
    email: { type: String, trim: true, lowercase: true },
    billingAddress: { type: String, trim: true },
    creditLimit: { type: Number, default: 0 },
    customerNote: { type: String, trim: true },
    customerId: { type: String, required: true, unique: true, trim: true },
    customerType: {
      type: String,
      enum: ["Retail", "Wholesale"],
      default: "Retail",
    },
    customerStatus: {
      type: String,
      enum: ["Active", "Suspense"],
      default: "Active",
    },
    joinDate: { type: Date, default: Date.now },
    documents: [documentSchema],
  },
  { timestamps: true }
);

const Customer = mongoose.model("Customer", customerSchema);

module.exports = Customer;
