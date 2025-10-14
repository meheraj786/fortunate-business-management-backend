require("dotenv").config();
const express = require("express");
const compression = require("compression");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { dbConnect } = require("./database/db.config");
const routers = require("./routes");

const app = express();

app.use(cors());
app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  compression({
    level: 6,
    threshold: 1024,
  })
);

const limiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 50,
  message: "Too many requests!!",
});
app.use(limiter);

(async () => {
  try {
    await dbConnect();

    app.use(routers);

    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
  } catch (error) {
    console.error("Server failed to start:", error.message);
  }
})();
