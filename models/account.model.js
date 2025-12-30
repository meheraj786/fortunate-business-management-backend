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
    let existingAccount;
    try {
      if (this.accountType === "Bank") {
        existingAccount = await this.constructor.findOne({
          bankName: this.bankName,
          accountNumber: this.accountNumber,
        });
        if (existingAccount) {
          const err = new Error(
            "A bank account with the same bank name and account number already exists."
          );
          return next(err);
        }
      } else if (this.accountType === "Mobile Banking") {
        existingAccount = await this.constructor.findOne({
          serviceName: this.serviceName,
          mobileNumber: this.mobileNumber,
        });
        if (existingAccount) {
          const err = new Error(
            "A mobile banking account with the same service name and mobile number already exists."
          );
          return next(err);
        }
      } else if (this.accountType === "Cash") {
        existingAccount = await this.constructor.findOne({
          accountName: this.accountName,
          accountHolderName: this.accountHolderName,
        });
        if (existingAccount) {
          const err = new Error(
            "A cash account with the same account name and account holder name already exists."
          );
          return next(err);
        }
      }
    } catch (error) {
      return next(error);
    }
  }
  next();
});

accountSchema.index({ status: 1 });

const Account = mongoose.model("Account", accountSchema);
module.exports = Account;