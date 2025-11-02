const mongoose = require("mongoose");

const specificationSchema = new mongoose.Schema({
  thickness_mm: { type: Number },
  width_mm: { type: Number },
  length_mm: { type: Number },
  grade: { type: String, trim: true },
});

const lcSchema = new mongoose.Schema(
  {
    basic_info: {
      lc_number: { type: String, required: true, trim: true },
      lc_opening_date: { type: Date, required: true },
      status: { type: String, trim: true },
      bank_name: { type: String, trim: true },
      supplier_name: { type: String, trim: true },
      supplier_country: { type: String, trim: true },
    },
    financial_info: {
      lc_amount_usd: { type: Number },
      exchange_rate: { type: Number },
      lc_amount_bdt: { type: Number },
      lc_margin_paid_bdt: { type: Number },
      bank_charges_bdt: { type: Number },
      insurance_cost_bdt: { type: Number },
    },
    product_info: [{
      item_name: { type: String, trim: true },
      specification: specificationSchema,
      quantity_ton: { type: Number },
      unit_price_usd: { type: Number },
      total_value_usd: { type: Number },
      total_value_bdt: { type: Number },
    }],
    shipping_customs_info: {
      port_of_shipment: { type: String, trim: true },
      port_of_arrival: { type: String, trim: true },
      expected_arrival_date: { type: Date },
      customs_duty_bdt: { type: Number },
      vat_bdt: { type: Number },
      ait_bdt: { type: Number },
      other_port_expenses_bdt: { type: Number },
    },
    agent_transport_info: {
      cnf_agent_name: { type: String, trim: true },
      cnf_agent_commission_bdt: { type: Number },
      indenting_agent_commission_bdt: { type: Number },
      transport_cost_bdt: { type: Number },
    },
    documents_notes: {
      uploaded_documents: [{ type: String, trim: true }],
      remarks: { type: String, trim: true },
    },
  },
  { timestamps: true }
);

// lcSchema.index({ "basic_info.lc_number": 1 });
// lcSchema.index({ "basic_info.status": 1 });

const LC = mongoose.model("LC", lcSchema);
module.exports = LC;
