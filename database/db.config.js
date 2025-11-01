const mongoose = require("mongoose");
exports.dbConnect = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("DB Connected");
  } catch (error) {
    console.log("Can't Connect DB");
  }
};
