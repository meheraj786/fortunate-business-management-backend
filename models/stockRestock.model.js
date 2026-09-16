const mongoose = require("mongoose");

// An immutable receiving ledger for stock added to an existing product.
// Product.quantity remains the fast current-balance field; this collection is
// the source of truth for every restock performed after this feature shipped.
const stockRestockSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
      index: true,
    },
    warehouse: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Warehouse",
      required: true,
      index: true,
    },
    quantityAdded: { type: Number, required: true, min: 0.000001 },
    quantityBefore: { type: Number, required: true, min: 0 },
    quantityAfter: { type: Number, required: true, min: 0 },
    receivedAt: { type: Date, required: true },
    notes: { type: String, trim: true, maxlength: 1000, default: "" },
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    // Makes a retried client request safe instead of receiving stock twice.
    idempotencyKey: { type: String, trim: true, sparse: true },
  },
  { timestamps: true },
);

stockRestockSchema.index({ product: 1, receivedAt: -1, _id: -1 });
stockRestockSchema.index({ product: 1, idempotencyKey: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model("StockRestock", stockRestockSchema);
