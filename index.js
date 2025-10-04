require("dotenv").config();
const express = require("express");
const { dbConnect } = require("./database/db.config");
const routers = require("./routes");
const app = express();

(() => {
  try {
    dbConnect();
    app.use(routers)
    app.listen(process.env.PORT, () => console.log("Server is running"));
  } catch (error) {
    console.log("Something Wrong");
  }
})();
