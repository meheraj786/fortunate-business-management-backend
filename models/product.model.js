const mongoose = require("mongoose");

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    category: { type: String, required: true, trim: true },
    LC: { type: mongoose.Schema.Types.ObjectId, ref: "LC", required: true },
    size: { type: String, trim: true },
    color: { type: String, trim: true },
    quantity: { type: Number, required: true, min: 0 },
    unit: { type: String, required: true, trim: true },
    unitPrice: { type: Number, required: true, min: 0 },
    warehouse: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Warehouse",
      required: true,
    },
  },
  { timestamps: true }
);

productSchema.statics.getInventoryStats = async function () {
  const totalProducts = await this.countDocuments();

  const totalQuantity = await this.aggregate([
    { $group: { _id: null, totalQuantity: { $sum: "$quantity" } } },
  ]);

  const lowStock = await this.countDocuments({ quantity: { $gt: 0, $lt: 20 } });
  const outOfStock = await this.countDocuments({ quantity: 0 });

  return {
    totalProducts,
    totalQuantity: totalQuantity[0]?.totalQuantity || 0,
    lowStock,
    outOfStock,
  };
};

productSchema.index({ quantity: 1 });

const Product = mongoose.model("Product", productSchema);
module.exports = Product;
