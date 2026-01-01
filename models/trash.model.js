const mongoose = require("mongoose");

const trashSchema = new mongoose.Schema(
  {
    docId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
      refPath: "model",
    },

    model: {
      type: String,
      required: true,
      enum: [
        "Product",
        "Category",
        "Customer",
        "DailyCash",
        "Invoice",
        "LC",
        "Account",
        "Sales",
        "Transaction",
        "Unit",
        "User",
        "Warehouse",
      ],
      index: true,
    },

    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },

    deletedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    metadata: { // New field for additional data
      type: mongoose.Schema.Types.Mixed,
      required: false, // Make it optional
      index: true, // Index for querying
    },
  },
  { timestamps: true }
);

// prevent duplicate trash entry
trashSchema.index({ docId: 1, model: 1 }, { unique: true });

const Trash = mongoose.model("Trash", trashSchema);

module.exports = Trash;
