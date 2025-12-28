const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
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
    default: "No Role",
    enum: [
      "ADMIN",
      "SUPER_ADMIN",
      "MANAGER",
      "Warehouse Keeper",
      "Accountant",
      "Sales Executive",
      "Operations Coordinator",
      "Logistics Officer",
      "Quality Inspector",
      "Customs Officer",
      "No Role",
    ],
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
        enum: ["LC", "SALE", "CASH", "STOCK", "BANKING", "CUSTOMER"],
      },
      permissions: [
        {
          type: [String],
          enum: ["CREATE", "GET", "UPDATE", "DELETE"],
        },
      ],
    },
  ],
  warehouse: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Warehouse",
      default: null,
    },
  ],
});

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
  );
};

userSchema.index({ access: 1 });
userSchema.index({ warehouse: 1 });

const User = mongoose.model("User", userSchema);

module.exports = User;
