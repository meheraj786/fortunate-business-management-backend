const mongoose = require("mongoose");
const mongoosePaginate = require("mongoose-paginate-v2");

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    productDescription: { type: String, trim: true },
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: true,
    },
    LC: { type: mongoose.Schema.Types.ObjectId, ref: "LC" },
    supplierName: { type: String, trim: true },
    thickness: { type: String, trim: true },
    width: { type: String, trim: true },
    length: { type: String, trim: true },
    color: { type: String, trim: true },
    grade: { type: String, trim: true },
    quantity: { type: Number, required: true, min: 0 },
    unit: { type: mongoose.Schema.Types.ObjectId, ref: "Unit", required: true },
    unitPrice: { type: Number, required: true, min: 0 },
    warehouse: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Warehouse",
      required: true,
    },
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
    lotClosed: {
      type: Boolean,
      default: false,
    },
    lotClosedAt: {
      type: Date,
      default: null,
    },
    lotClosedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    lotClosedQuantity: {
      type: Number,
      default: null,
    },
    // Transfer Lineage — populated only on products created via partial transfer
    transferredFrom: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      default: null,
    },
    transferredAt: {
      type: Date,
      default: null,
    },
    transferredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    transferNotes: {
      type: String,
      trim: true,
      default: null,
    },
  },
  { timestamps: true, optimisticConcurrency: true },
);

productSchema.index({ name: "text" });

productSchema.statics.getInventoryStats = async function (warehouseId) {
  const matchQuery = warehouseId
    ? { warehouse: new mongoose.Types.ObjectId(warehouseId) }
    : {};

  const totalProductsCount = await this.countDocuments(matchQuery); // Total number of product documents (regardless of stock)

  const inStockProductsCount = await this.countDocuments({
    // Count of products with quantity > 0
    ...matchQuery,
    quantity: { $gt: 0 },
  });

  const totalQuantity = await this.aggregate([
    { $match: matchQuery },
    { $group: { _id: null, totalQuantity: { $sum: "$quantity" } } },
  ]);

  const lowStockProductsCount = await this.countDocuments({
    ...matchQuery,
    quantity: { $gt: 0, $lt: 20 },
  });
  const outOfStockProductsCount = await this.countDocuments({
    ...matchQuery,
    quantity: 0,
  });

  return {
    totalProductsCount, // Total number of distinct product documents (including out of stock)
    inStockProductsCount, // Number of distinct product documents with quantity > 0
    totalQuantity: totalQuantity[0]?.totalQuantity || 0, // Sum of quantities
    lowStockProductsCount, // Number of products in low stock
    outOfStockProductsCount, // Number of products out of stock
  };
};

productSchema.index({ quantity: 1 });
productSchema.index({ warehouse: 1 });
productSchema.index({ category: 1 });
productSchema.plugin(mongoosePaginate);

const Product = mongoose.model("Product", productSchema);
module.exports = Product;
