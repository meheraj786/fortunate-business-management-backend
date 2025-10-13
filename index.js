require("dotenv").config();
const express = require("express");
const { dbConnect } = require("./database/db.config");
const routers = require("./routes");
const app = express();

(async () => {
  try {
    app.use(
      compression({
        level: 6,
        threshold: 1024,
      })
    );
    await dbConnect();
    app.use(routers);
    app.listen(process.env.PORT, () => console.log("Server is running"));
  } catch (error) {
    console.log("Something Wrong");
  }
})();
