const mongoose = require("mongoose");
const logger = require("../utils/logger");
exports.dbConnect = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    logger.info("DB Connected");
  } catch (error) {
    logger.error("Can't Connect DB", error);
    process.exit(1);
  }
};
