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
    basic_info: {
      lc_number: { type: String, required: true, trim: true },
      lc_opening_date: { type: Date, required: true },
      status: { type: String, trim: true, required: true, enum: ["Draft", "Active", "Completed", "Cancelled"] },
      bank_name: { type: String, trim: true, required: true },
      supplier_name: { type: String, trim: true, required: true },
      supplier_country: { type: String, trim: true, required: true },
    },
    financial_info: {
      lc_amount_usd: { type: Number, required: true },
      exchange_rate: { type: Number, required: true },
      lc_amount_bdt: { type: Number },
      lc_margin_paid_bdt: { type: Number, required: true },
      bank_charges_bdt: { type: Number, required: true },
      insurance_cost_bdt: { type: Number, required: true },
      other_expenses: [otherExpenseSchema],
    },
    product_info: [
      {
        item_name: { type: String, trim: true, required: true },
        specification: specificationSchema,
        quantity_unit: { type: String, trim: true, required: true },
        quantity_ton: { type: Number, required: true },
        unit_price_usd: { type: Number, required: true },
        total_value_usd: { type: Number },
      },
    ],
    shipping_customs_info: {
      port_of_shipment: { type: String, trim: true },
      expected_arrival_date: { type: Date },
      customs_duty_bdt: { type: Number },
      vat_bdt: { type: Number },
      ait_bdt: { type: Number },
      other_expenses: [otherExpenseSchema],
    },
    agent_transport_info: {
      cnf_agent_name: { type: String, trim: true },
      cnf_agent_commission_bdt: { type: Number },
      indenting_agent_commission_bdt: { type: Number },
      transport_cost_bdt: { type: Number },
      other_expenses: [otherExpenseSchema],
    },
    documents_notes: {
      uploaded_documents: [
        {
          original_name: { type: String, trim: true },
          stored_name: { type: String, trim: true },
          mime_type: { type: String, trim: true },
          size_bytes: { type: Number },
          hash_sha256: { type: String, trim: true },
        },
      ],
      remarks: { type: String, trim: true },
    },
    other_expenses: [otherExpenseSchema],
  },
  { timestamps: true }
);

// lcSchema.index({ "basic_info.lc_number": 1 });
// lcSchema.index({ "basic_info.status": 1 });

const LC = mongoose.model("LC", lcSchema);
module.exports = LC;
