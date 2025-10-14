const mongoose = require("mongoose");

const customerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: {
      type: String,
      required: true,
      trim: true,
      match: [
        /^\+880\s?\d{4,10}$/,
        "Please enter a valid Bangladeshi phone number",
      ],
    },
    location: { type: String, trim: true },

    basicInfo: {
      customerId: { type: String, unique: true, required: true },
      type: { type: String, enum: ["Retail", "Wholesale"], default: "Retail" },
      status: { type: String, enum: ["Active", "Inactive"], default: "Active" },
      profilePhoto: { type: String, default: null },
      joinDate: { type: Date },
      customerTier: {
        type: String,
        enum: ["Bronze", "Silver", "Gold"],
        default: "Bronze",
      },
    },

    contactInfo: {
      phone: { type: String },
      email: { type: String },
      website: { type: String, default: null },
      billingAddress: { type: String },
      shippingAddress: { type: String },
      contactPerson: { type: String },
      contactPersonPhone: { type: String },
      contactPersonEmail: { type: String },
    },

    businessInfo: {
      companyName: { type: String },
      businessType: { type: String },
      tradeLicense: { type: String },
      tin: { type: String },
      vatInfo: { type: String },
      creditLimit: { type: Number, default: 0 },
      paymentTerms: { type: String },
      currency: { type: String, default: "BDT" },
    },

    bankInfo: {
      bankName: { type: String },
      branch: { type: String },
      accountNumber: { type: String },
      routingNumber: { type: String },
      swiftCode: { type: String },
      iban: { type: String },
    },

    documents: [
      {
        name: { type: String },
        type: { type: String },
        size: { type: String },
        uploadDate: { type: Date },
      },
    ],

    notes: {
      remarks: { type: String },
      assignedManager: { type: String },
      managerContact: { type: String },
      lastContact: { type: Date },
      nextFollowUp: { type: Date },
      specialInstructions: { type: String },
    },

    transactions: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Sales",
      },
    ],
  },
  { timestamps: true }
);

customerSchema.index({ "basicInfo.customerId": 1 });
customerSchema.index({ phone: 1 });
customerSchema.index({ "basicInfo.status": 1 });

const Customer = mongoose.model("Customer", customerSchema);
module.exports = Customer;
