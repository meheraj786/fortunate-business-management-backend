const mongoose = require("mongoose");
const mongoosePaginate = require("mongoose-paginate-v2");

const dailyCashSchema = new mongoose.Schema(
  {
    date: {
      type: Date,
      required: true,
      // The time part will be ignored by the logic, only the date part matters.
    },
    status: {
      type: String,
      enum: ["Open", "Closed"],
      required: true,
    },
    openingBalance: {
      type: Number,
      required: true,
    },
    closingBalance: {
      // This will be set when the cash is closed.
      type: Number,
    },
    openedAt: {
      type: Date,
      default: Date.now,
    },
    closedAt: {
      type: Date,
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
  },
  { timestamps: true },
);

dailyCashSchema.plugin(mongoosePaginate);

const DailyCash = mongoose.model("DailyCash", dailyCashSchema);

module.exports = DailyCash;
