const mongoose = require("mongoose");

const warehouseSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  location: {
    type: String,
    required: true,
    trim: true,
  },
    isDeleted: {
    type: Boolean,
    default: false,
    index: true,
  },
  manager: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  ],
  product: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
    },
  ],
});

warehouseSchema.index({ manager: 1 });
warehouseSchema.index({ product: 1 });

const Warehouse = mongoose.model("Warehouse", warehouseSchema);
module.exports = Warehouse;
