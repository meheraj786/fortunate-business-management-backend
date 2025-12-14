const mongoose = require("mongoose");

const costSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  amount: { type: Number, required: true },
  date: { type: Date, required: true, default: Date.now }, // date and time 
  paymentMethod: {
    type: String,
    required: true,
    enum: ["Cash", "Bank", "Mobile Banking"],
  },
  accountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Account",
  },
});

const lcSchema = new mongoose.Schema(
  {
    basicInfo: {
      lcNumber: { type: String, required: true, trim: true },
      lcOpeningDate: { type: Date, required: true },
      status: {
        type: String,
        trim: true,
        required: true,
        enum: ["Draft", "Active", "Completed", "Cancelled"],
      },
      supplierName: { type: String, trim: true, required: true },
      supplierCountry: { type: String, trim: true, required: true },
      accountId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Account",
        required: true,
      },
    },
    financialInfo: {
      lcAmountUsd: { type: Number, required: true },
      exchangeRate: { type: Number, required: true },
      lcAmountBdt: { type: Number, required: true },
      costs: [costSchema],
    },
    productInfo: [
      {
        itemName: { type: String, trim: true, required: true },
        thickness: { type: String, trim: true },
        width: { type: String, trim: true },
        length: { type: String, trim: true },
        grade: { type: String, trim: true },
        unitPriceUsd: { type: Number, required: true },
        quantity: { type: Number, required: true },
        quantityUnit: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Unit",
          required: true,
        },
        totalValueUsd: { type: Number, required: true },
      },
    ],
    shippingCustomsInfo: {
      portOfShipment: { type: String, trim: true },
      expectedArrivalDate: { type: Date },
      costs: [costSchema],
    },
    agentTransportInfo: {
      costs: [costSchema],
    },
    documentsNotes: {
      uploadedDocuments: [
        {
          originalName: { type: String, trim: true },
          storedName: { type: String, trim: true },
          mimeType: { type: String, trim: true },
          sizeBytes: { type: Number },
          hashSha256: { type: String, trim:true },
        },
      ],
      note: { type: String, trim: true, default: "No notes given" },
    },
    otherExpenses: {
      costs: [costSchema],
    },
  },
  { timestamps: true }
);

const LC = mongoose.model("LC", lcSchema);
module.exports = LC;
