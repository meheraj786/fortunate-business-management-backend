const mongoose = require("mongoose");

const teamMemberSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },

    phone: {
      type: String,
      required: true,
      trim: true,
      match: [/^\+880\s?\d{4,10}$/, "Please enter a valid Bangladeshi phone number"],
    },

    role: {
      type: String,
      required: true,
      trim: true,
      enum: [
        "Manager",
        "Warehouse Keeper",
        "Accountant",
        "Sales Executive",
        "Operations Coordinator",
        "Logistics Officer",
        "Quality Inspector",
        "Customs Officer",
      ],
    },

    warehouse: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Warehouse",
      required: true,
    },
  }
);

teamMemberSchema.index({ role: 1 });
teamMemberSchema.index({ warehouse: 1 });

const TeamMember = mongoose.model("TeamMember", teamMemberSchema);

module.exports = TeamMember;
