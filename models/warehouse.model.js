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
  manager: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TeamMember",
    },
  ],
  product: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
    },
  ]
});

warehouseSchema.index({ manager: 1 });
warehouseSchema.index({ product: 1 });

const Warehouse = mongoose.model("Warehouse", warehouseSchema);
module.exports = Warehouse;
