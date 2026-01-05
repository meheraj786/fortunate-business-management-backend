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
    required: function () {
      return ["Cash", "Bank", "Mobile Banking"].includes(this.paymentMethod);
    },
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
        },
      ],
      note: { type: String, trim: true, default: "No notes given" },
    },
    otherExpenses: {
      costs: [costSchema],
    },
    totalCost: { type: Number, default: 0 },
      isDeleted: {
    type: Boolean,
    default: false,
    index: true,
  },
  },
  { timestamps: true }
);

lcSchema.index({ "basicInfo.lcNumber": 1 }); // Add index here

// Mongoose 'pre-save' middleware to calculate totalCost
lcSchema.pre("save", function (next) {
  let calculatedCost = 0;

  if (this.financialInfo && this.financialInfo.costs) {
    calculatedCost += this.financialInfo.costs.reduce(
      (sum, cost) => sum + (cost.amount || 0),
      0
    );
  }
  if (this.shippingCustomsInfo && this.shippingCustomsInfo.costs) {
    calculatedCost += this.shippingCustomsInfo.costs.reduce(
      (sum, cost) => sum + (cost.amount || 0),
      0
    );
  }
  if (this.agentTransportInfo && this.agentTransportInfo.costs) {
    calculatedCost += this.agentTransportInfo.costs.reduce(
      (sum, cost) => sum + (cost.amount || 0),
      0
    );
  }
  if (this.otherExpenses && this.otherExpenses.costs) {
    calculatedCost += this.otherExpenses.costs.reduce(
      (sum, cost) => sum + (cost.amount || 0),
      0
    );
  }

  this.totalCost = calculatedCost;
  next();
});

const LC = mongoose.model("LC", lcSchema);
module.exports = LC;
