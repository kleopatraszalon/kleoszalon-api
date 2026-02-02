const express = require("express");
const app = express();

const PORT = process.env.PORT || 3000;

// egyszerű statikus oldal
app.get("/", (req, res) => {
  res.send(`
    <html lang="hu">
      <head>
        <meta charset="utf-8" />
        <title>Kleopátra Szalon • Fejlesztés alatt</title>
        <style>
          body {
            background: #0f172a;
            color: #f8fafc;
            font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0;
          }
          .card {
            background: rgba(15,23,42,0.6);
            border: 1px solid rgba(148,163,184,0.2);
            border-radius: 1rem;
            padding: 2rem 2.5rem;
            max-width: 480px;
            text-align: center;
            box-shadow: 0 30px 80px rgba(0,0,0,0.6);
          }
          .title {
            font-size: 1rem;
            font-weight: 500;
            color: #38bdf8;
            text-transform: uppercase;
            letter-spacing: .08em;
            margin-bottom: .75rem;
          }
          .mainline {
            font-size: 1.25rem;
            line-height: 1.4;
            font-weight: 600;
            color: #f8fafc;
            margin-bottom: 1rem;
          }
          .sub {
            font-size: .9rem;
            line-height: 1.5;
            color: #94a3b8;
          }
          .badge {
            display:inline-block;
            background:#1e293b;
            border:1px solid rgba(148,163,184,.3);
            color:#e2e8f0;
            font-size:.7rem;
            font-weight:500;
            border-radius:.5rem;
            padding:.4rem .6rem;
            margin-top:1.5rem;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="title">Kleopátra Szalon</div>
          <div class="mainline">
            Itt a Kleopátra Szalon vállalatirányítási rendszere épül.
          </div>
          <div class="sub">
            Foglalások. Dolgozók jelenléte. Pénzügy. Raktár. Minden egy helyen.
          </div>
          <div class="badge">Fejlesztés alatt • Privát rendszer</div>
        </div>
      </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
