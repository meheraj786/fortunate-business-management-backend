const mongoose = require("mongoose");

const specificationSchema = new mongoose.Schema({
  thickness_mm: { type: Number },
  width_mm: { type: Number },
  length_mm: { type: Number },
  grade: { type: String, trim: true },
});

const otherExpenseSchema = new mongoose.Schema({
  name: { type: String, trim: true, required: true },
  amount: { type: Number, required: true },
  date: { type: Date, default: Date.now },
});

const lcSchema = new mongoose.Schema(
  {
    basicInfo: {
      lcNumber: { type: String, required: true, trim: true },
      lcOpeningDate: { type: Date, required: true },
      status: { type: String, trim: true, required: true, enum: ["Draft", "Active", "Completed", "Cancelled"] },
      bankName: { type: String, trim: true, required: true },
      supplierName: { type: String, trim: true, required: true },
      supplierCountry: { type: String, trim: true, required: true },
    },
    financialInfo: {
      lcAmountUsd: { type: Number, required: true },
      exchangeRate: { type: Number, required: true },
      lcAmountBdt: { type: Number },
      lcMarginPaidBdt: { type: Number, required: true },
      bankChargesBdt: { type: Number, required: true },
      insuranceCostBdt: { type: Number, required: true },
      otherExpenses: [otherExpenseSchema],
    },
    productInfo: [
      {
        itemName: { type: String, trim: true, required: true },
        specification: specificationSchema,
        quantityUnit: { type: mongoose.Schema.Types.ObjectId, ref: "Unit", required: true },
        quantityValue: { type: Number, required: true },
        unitPriceUsd: { type: Number, required: true },
        totalValueUsd: { type: Number },
      },
    ],
    shippingCustomsInfo: {
      portOfShipment: { type: String, trim: true },
      expectedArrivalDate: { type: Date },
      customsDutyBdt: { type: Number },
      vatBdt: { type: Number },
      aitBdt: { type: Number },
      otherExpenses: [otherExpenseSchema],
    },
    agentTransportInfo: {
      cnfAgentName: { type: String, trim: true },
      cnfAgentCommissionBdt: { type: Number },
      indentingAgentCommissionBdt: { type: Number },
      transportCostBdt: { type: Number },
      otherExpenses: [otherExpenseSchema],
    },
    documentsNotes: {
      uploadedDocuments: [
        {
          originalName: { type: String, trim: true },
          storedName: { type: String, trim: true },
          mimeType: { type: String, trim: true },
          sizeBytes: { type: Number },
          hashSha256: { type: String, trim: true },
        },
      ],
      remarks: { type: String, trim: true },
    },
    otherExpenses: [otherExpenseSchema],
  },
  { timestamps: true }
);

// lcSchema.index({ "basic_info.lc_number": 1 });
// lcSchema.index({ "basic_info.status": 1 });

const LC = mongoose.model("LC", lcSchema);
module.exports = LC;
