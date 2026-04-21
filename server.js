require("dotenv").config();
const express = require("express");

const app = express();
const PORT = process.env.PORT || 10000;

app.get("/", (req, res) => {
  res.send("ATC24 Backend Running");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});