const mongoose = require("mongoose");

const goodsInfoSchema = new mongoose.Schema({
  productName: { type: String, required: true, trim: true },
  hsCode: { type: String, trim: true },
  quantity: { type: Number, required: true, min: 0 },
  unit: { type: String, trim: true },
  unitPrice: { type: Number, required: true, min: 0 },
  totalValue: { type: Number, required: true, min: 0 },
  description: { type: String, trim: true },
});

const lcSchema = new mongoose.Schema(
  {
    lcNumber: { type: String, required: true, unique: true, trim: true },
    status: {
      type: String,
      required: true,
      enum: ["Active", "Closed", "Expired"],
    },
    openDate: { type: Date, required: true },
    dueDate: { type: Date, required: true },
    products: { type: String, trim: true },
    quantity: { type: String, trim: true },
    totalAmount: { type: Number, required: true },
    beneficiary: { type: String, trim: true },

    basicInfo: {
      lcNumber: { type: String, trim: true },
      lcType: { type: String, trim: true },
      issueDate: { type: Date },
      expiryDate: { type: Date },
      lcValue: { type: Number },
      currency: { type: String, trim: true },
      status: { type: String, trim: true },
    },
    buyerInfo: {
      name: { type: String, trim: true },
      company: { type: String, trim: true },
      address: { type: String, trim: true },
      contactPerson: { type: String, trim: true },
      phone: { type: String, trim: true },
      email: { type: String, trim: true },
    },
    sellerInfo: {
      name: { type: String, trim: true },
      company: { type: String, trim: true },
      address: { type: String, trim: true },
      bankName: { type: String, trim: true },
      accountNumber: { type: String, trim: true },
      swiftCode: { type: String, trim: true },
      email: { type: String, trim: true },
    },
    bankInfo: {
      issuingBank: { type: String, trim: true },
      advisingBank: { type: String, trim: true },
      correspondentBank: { type: String, trim: true },
      swiftCode: { type: String, trim: true },
      branch: { type: String, trim: true },
      accountManager: { type: String, trim: true },
      managerContact: { type: String, trim: true },
    },
    shipmentInfo: {
      portOfLoading: { type: String, trim: true },
      portOfDischarge: { type: String, trim: true },
      shipmentDate: { type: Date },
      lastShipmentDate: { type: Date },
      transportType: { type: String, trim: true },
      shippingCompany: { type: String, trim: true },
      insurance: { type: String, trim: true },
      incoterms: { type: String, trim: true },
    },
    goodsInfo: [goodsInfoSchema],
    paymentInfo: {
      terms: { type: String, trim: true },
      marginAmount: { type: Number },
      bankCharges: { type: Number },
      commission: { type: Number },
      dueDate: { type: Date },
      status: { type: String, trim: true },
      paidAmount: { type: Number },
      paymentDate: { type: Date },
    },
    documentsRequired: [{ type: String, trim: true }],
    tracking: {
      status: { type: String, trim: true },
      remarks: { type: String, trim: true },
      attachments: [
        {
          name: { type: String, trim: true },
          type: { type: String, trim: true },
          size: { type: String, trim: true },
        },
      ],
      lastUpdated: { type: Date },
    },
    expenses: [{ type: mongoose.Schema.Types.ObjectId, ref: "Expense" }],
  },
  { timestamps: true }
);

lcSchema.index({ lcNumber: 1 });
lcSchema.index({ status: 1 });

const LC = mongoose.model("LC", lcSchema);
module.exports = LC;
