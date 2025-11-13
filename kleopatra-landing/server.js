// server.js – egyszerű Express szerver külön porton
const express = require("express");
const path = require("path");

const app = express();

// statikus fájlok a projekt gyökeréből
app.use(express.static(path.join(__dirname)));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// külön port (pl. 3002), de környezeti változóból is olvassa
const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`Kleopátra landing fut: http://localhost:${PORT}`);
});
