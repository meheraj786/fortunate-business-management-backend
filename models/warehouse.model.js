const mongoose = require("mongoose");

const warehouseSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  location: {
    type: String,
    trim: true,
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
