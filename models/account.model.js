const mongoose = require("mongoose");

const accountSchema = new mongoose.Schema(
  {
    accountType: {
      type: String,
      enum: ["Bank", "Mobile Banking", "Cash"],
      required: true,
    },
    // Common fields
    accountName: {
      // User-friendly name like "My DBBL Account" or "Bkash Personal"
      type: String,
      required: true,
      trim: true,
      unique: true,
    },
    accountHolderName: { type: String, trim: true },

    // Bank specific
    bankName: { type: String, trim: true },
    branchName: { type: String, trim: true },
    accountNumber: { type: String, trim: true },
    swiftCode: { type: String, trim: true },
    routingNumber: { type: String, trim: true },

    // Mobile Banking specific
    serviceName: { type: String, trim: true }, // e.g., Bkash, Nagad
    mobileNumber: { type: String, trim: true },

    balance: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

const Account = mongoose.model("Account", accountSchema);
module.exports = Account;
