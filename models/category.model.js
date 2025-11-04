const mongoose = require("mongoose");

const categorySchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true,
    trim: true,
  },
  description: {
    type: String,
    default: "No description",
    trim: true,
  },
});

const Category = mongoose.model("Category", categorySchema);

module.exports = Category;
