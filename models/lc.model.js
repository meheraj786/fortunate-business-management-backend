const mongoose = require("mongoose");
const mathUtil = require("../utils/math.util");

const costSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  amount: { type: Number, required: true },
  amountUsd: { type: Number },
  costExchangeRate: { type: Number },
  date: { type: Date, required: true, default: Date.now }, // date and time
  paymentMethod: {
    type: String,
    required: true,
    enum: ["Cash", "Bank", "Mobile Banking"],
  },
  accountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Account",
    required: function () {
      return ["Cash", "Bank", "Mobile Banking"].includes(this.paymentMethod);
    },
  },
});

// Helper: returns true (making the field required) only when status is NOT "Draft" or "Cancelled"
const requiredIfNotDraft = function () {
  const status = this.basicInfo?.status;
  return status !== "Draft" && status !== "Cancelled";
};

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
      supplierName: { type: String, trim: true, required: [requiredIfNotDraft, "Supplier Name is required for non-Draft LCs"] },
      supplierCountry: { type: String, trim: true, required: [requiredIfNotDraft, "Supplier Country is required for non-Draft LCs"] },
      accountId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Account",
        required: [requiredIfNotDraft, "Bank Account is required for non-Draft LCs"],
      },
    },
    financialInfo: {
      lcAmountUsd: { type: Number, required: [requiredIfNotDraft, "LC Amount (USD) is required for non-Draft LCs"] },
      exchangeRate: { type: Number, required: [requiredIfNotDraft, "Exchange Rate is required for non-Draft LCs"] },
      lcAmountBdt: { type: Number, required: [requiredIfNotDraft, "LC Amount (BDT) is required for non-Draft LCs"] },
      costs: [costSchema],
    },
    productInfo: [
      {
        itemName: { type: String, trim: true },
        thickness: { type: String, trim: true },
        width: { type: String, trim: true },
        length: { type: String, trim: true },
        grade: { type: String, trim: true },
        unitPriceUsd: { type: Number },
        quantity: { type: Number },
        quantityUnit: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Unit",
        },
        totalValueUsd: { type: Number },
      },
    ],
    shippingCustomsInfo: {
      portOfShipment: { type: String, trim: true },
      portOfDestination: { type: String, trim: true },
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
          path: { type: String }, // Stores the 'YYYY/MM' path
          mimeType: { type: String, trim: true },
          sizeBytes: { type: Number },
        },
      ],
      note: { type: String, trim: true, default: "No notes given" },
    },
    otherExpenses: {
      costs: [costSchema],
    },
    documentProductInfo: {
      products: [
        {
          itemName: { type: String, trim: true },
          thickness: { type: String, trim: true },
          width: { type: String, trim: true },
          length: { type: String, trim: true },
          grade: { type: String, trim: true },
          unitPriceUsd: { type: Number },
          quantity: { type: Number },
          quantityUnit: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Unit",
          },
          totalValueUsd: { type: Number },
        },
      ],
      costs: [costSchema],
    },
    totalCost: { type: Number, default: 0 },
    totalDocumentValue: { type: Number, default: 0 },
    totalDocumentCostUsd: { type: Number, default: 0 },
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
  { timestamps: true, optimisticConcurrency: true },
);

lcSchema.index({ "basicInfo.lcNumber": 1 }, { unique: true }); // Ensure lcNumber is unique
lcSchema.index({ isDeleted: 1, "basicInfo.lcOpeningDate": -1 });
lcSchema.index({ isDeleted: 1, "basicInfo.status": 1 });

// Mongoose 'pre-save' middleware to calculate totalCost
lcSchema.pre("save", function (next) {
  let calculatedCost = 0;

  if (this.financialInfo && this.financialInfo.costs) {
    calculatedCost = this.financialInfo.costs.reduce(
      (sum, cost) => mathUtil.add(sum, cost.amount || 0),
      calculatedCost,
    );
  }
  if (this.shippingCustomsInfo && this.shippingCustomsInfo.costs) {
    calculatedCost = this.shippingCustomsInfo.costs.reduce(
      (sum, cost) => mathUtil.add(sum, cost.amount || 0),
      calculatedCost,
    );
  }
  if (this.agentTransportInfo && this.agentTransportInfo.costs) {
    calculatedCost = this.agentTransportInfo.costs.reduce(
      (sum, cost) => mathUtil.add(sum, cost.amount || 0),
      calculatedCost,
    );
  }
  if (this.otherExpenses && this.otherExpenses.costs) {
    calculatedCost = this.otherExpenses.costs.reduce(
      (sum, cost) => mathUtil.add(sum, cost.amount || 0),
      calculatedCost,
    );
  }
  if (this.documentProductInfo && this.documentProductInfo.costs) {
    calculatedCost = this.documentProductInfo.costs.reduce(
      (sum, cost) => mathUtil.add(sum, cost.amount || 0),
      calculatedCost,
    );
  }

  this.totalCost = mathUtil.round(calculatedCost);

  // Calculate Total Document Value (sum of document products' totalValueUsd)
  this.totalDocumentValue = mathUtil.round(
    (this.documentProductInfo?.products || []).reduce(
      (sum, p) => mathUtil.add(sum, p.totalValueUsd || 0),
      0,
    ),
  );

  // Calculate Total Document Cost in USD (sum of document costs' amountUsd)
  this.totalDocumentCostUsd = mathUtil.round(
    (this.documentProductInfo?.costs || []).reduce(
      (sum, c) => mathUtil.add(sum, c.amountUsd || 0),
      0,
    ),
  );

  next();
});

const LC = mongoose.model("LC", lcSchema);
module.exports = LC;
