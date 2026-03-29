const mongoose = require("mongoose");
const { Schema } = mongoose;

const documentSchema = new Schema({
  originalName: { type: String, required: true },
  storedName: { type: String, required: true },
  path: { type: String, required: true },
  mimeType: { type: String, required: true },
  sizeBytes: { type: Number, required: true },
  uploadDate: { type: Date, default: Date.now },
});

const customerSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    companyName: { type: String, trim: true },
    phone: {
      type: String,
      trim: true,
    },
    email: { type: String, trim: true, lowercase: true },
    billingAddress: { type: String, trim: true },
    creditLimit: { type: Number, default: null },
    creditBalance: { type: Number, default: 0, min: 0 },
    openingDue: { type: Number, default: 0 },
    customerNote: { type: String, trim: true },
    customerId: { type: String, required: true, unique: true, trim: true },
    customerType: {
      type: String,
      enum: ["Retail", "Wholesale"],
      default: "Retail",
    },
    customerStatus: {
      type: String,
      enum: ["Active", "Suspended"],
      default: "Active",
    },
    joinDate: { type: Date, default: Date.now },
    documents: [documentSchema],
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

customerSchema.index({ isDeleted: 1, joinDate: -1 });
customerSchema.index({ isDeleted: 1, customerStatus: 1 });

// Additional indexes for search and filtering
customerSchema.index({ name: "text", phone: "text", customerId: "text" });
customerSchema.index({ customerType: 1, isDeleted: 1 });
customerSchema.index({ createdAt: -1 });

const Customer = mongoose.model("Customer", customerSchema);

module.exports = Customer;
