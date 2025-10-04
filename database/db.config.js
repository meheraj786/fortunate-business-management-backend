const mongoose = require("mongoose");
exports.dbConnect = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("DB Connect");
  } catch (error) {
    console.log("Can't Connect DB");
  }
};
