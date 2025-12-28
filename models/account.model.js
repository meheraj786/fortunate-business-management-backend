const mongoose = require("mongoose");

const accountSchema = new mongoose.Schema(
  {
    accountType: {
      type: String,
      enum: ["Bank", "Mobile Banking", "Cash"],
      required: true,
    },
    accountName: { type: String, required: true, trim: true },
    accountHolderName: { type: String, trim: true, required: true },
    bankName: { type: String, trim: true, required: function () { return this.accountType === "Bank"; } },
    branchName: { type: String, trim: true, required: function () { return this.accountType === "Bank"; } },
    accountNumber: { type: String, trim: true, required: function () { return this.accountType === "Bank"; } },
    swiftCode: { type: String, trim: true },
    routingNumber: { type: String, trim: true },
    serviceName: { type: String, trim: true, required: function () { return this.accountType === "Mobile Banking"; } },
    mobileNumber: { type: String, trim: true, required: function () { return this.accountType === "Mobile Banking"; } },
    balance: { type: Number, default: 0 },
    status: { type: String, enum: ["Active", "Archived"], default: "Active" },
    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

// --- QUERY MIDDLEWARE (Soft Delete Filter) ---

accountSchema.pre(/^find/, function (next) {
  const query = this.getQuery();
  if (query.isDeleted !== undefined) {
    return next();
  }
  
  this.where({ isDeleted: { $ne: true } });
  next();
});

// --- UNIQUE CHECK MIDDLEWARE ---
accountSchema.pre("save", async function (next) {
  if (this.isNew) {
    let query = { isDeleted: { $ne: true } };
    if (this.accountType === "Bank") {
      query.bankName = this.bankName;
      query.accountNumber = this.accountNumber;
    } else if (this.accountType === "Mobile Banking") {
      query.serviceName = this.serviceName;
      query.mobileNumber = this.mobileNumber;
    } else if (this.accountType === "Cash") {
      query.accountName = this.accountName;
      query.accountHolderName = this.accountHolderName;
    }

    const existingAccount = await this.constructor.findOne(query);
    if (existingAccount) {
      return next(new Error(`Account with these details already exists.`));
    }
  }
  next();
});

const Account = mongoose.model("Account", accountSchema);
module.exports = Account;