const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
    avatar: {
      type: String,
      default:
        "https://upload.wikimedia.org/wikipedia/commons/9/99/Sample_User_Icon.png",
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, "Please enter a valid email address"],
    },
    password: {
      type: String,
      required: true,
      select: false,
      minlength: [8, "Password must be at least 8 characters"],
    },
    phone: {
      type: String,
      default: "Not Provided",
    },

    roleName: {
      type: String,
      enum: ["SUPER_ADMIN", "ADMIN", "USER", "No Role"],
      default: "No Role",
    },
    description: {
      type: String,
      default: "No description provided.",
    },
    location: {
      type: String,
      required: true,
      default: "Center",
    },
    access: [
      {
        module: {
          type: String,
          required: true,
          enum: [
            "USER",
            "WAREHOUSE",
            "PRODUCT",
            "LC",
            "SALE",
            "CASH",
            "ACCOUNT",
            "TRANSACTION",
            "CUSTOMER",
            "CATEGORY",
            "UNIT",
            "SETTINGS",
            "TRASH",
            "AUDIT",
            "ADVANCE_PAYMENT",
          ],
        },
        permissions: [String],
      },
    ],
    warehouse: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Warehouse",
        default: null,
      },
    ],
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
    lastLogoutAt: {
      type: Date,
      default: null,
      select: false, // Not needed in most queries, only auth check
    },
  },
  { timestamps: true },
);

userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

userSchema.methods.isPasswordCorrect = async function (password) {
  return await bcrypt.compare(password, this.password);
};

userSchema.methods.generateToken = function () {
  return jwt.sign(
    {
      _id: this._id,
      email: this.email,
      role: this.roleName,
    },
    process.env.SECRET_KEY,
    { expiresIn: "15m" },
  );
};

userSchema.index({ access: 1 });
userSchema.index({ warehouse: 1 });

// Additional indexes for authentication and authorization
userSchema.index({ email: 1, isDeleted: 1 });
userSchema.index({ roleName: 1 });

const User = mongoose.model("User", userSchema);

module.exports = User;
