// src/server.ts
import express from "express";
import cors from "cors";
import bcrypt from "bcrypt";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import pool from "./db";
import meRoutes from "./routes/me";

// Almodulok
import workOrderRoutes from "./routes/workOrders";
import bookingsRoutes from "./routes/bookings";
import transactionsRoutes from "./routes/transactions";
import locationsRoutes from "./routes/locations";
import dashboardRoutes from "./routes/dashboard"; // 🔹 ÚJ
import employeesRouter from "./routes/employees";
import servicesRouter from "./routes/services";

import sendLoginCodeEmail  from "./mailer";
import { saveCodeForEmail, consumeCode } from "./tempCodeStore";
import servicesAvailableRoutes from "./routes/services_available";
import employeeCalendarRoutes from "./routes/employee_calendar";


dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// ===========================================================
// 🔧 ALAPBEÁLLÍTÁSOK
// ===========================================================
app.use(cors({
  origin: [
    "http://localhost:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3001",
    "http://10.40.23.26:3001",
  ],
  credentials: true,
}));
app.use(express.json());

app.use("/api/employees", employeesRouter);
app.use("/api/services", servicesRouter);

// Teszt endpoint
app.get("/", (_req, res) => {
  res.send("✅ Backend fut és CORS be van állítva");
});

// 1️⃣ /api/login
// - email + jelszó ellenőrzés
// - ha jó, generál egy 6 jegyű kódot
// - eltárolja memóriában
// - elküldi Gmail-lel

app.use("/api/me", meRoutes);

app.use("/api/services/available", servicesAvailableRoutes);

app.use("/api/employee-calendar", employeeCalendarRoutes); // naptárhoz

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    // lekérjük a felhasználót
    const result = await pool.query(
      "SELECT id, email, password_hash, role, location_id FROM users WHERE email = $1",
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, error: "Hibás e-mail vagy jelszó" });
    }

    const user = result.rows[0];

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ success: false, error: "Hibás e-mail vagy jelszó" });
    }

    // generálunk 6 jegyű kódot
    const code = Math.floor(100000 + Math.random() * 900000).toString();

    // eltároljuk memóriában
    const expiresMin = parseInt(process.env.CODE_EXPIRES_MIN || "5", 10);
    saveCodeForEmail(email, {
      code,
      userId: user.id,
      role: user.role || "guest",
      location_id: user.location_id || null,
      expiresAt: Date.now() + expiresMin * 60 * 1000,
    });

    // kiküldjük e-mailben
    try {
      await sendLoginCodeEmail(email, code);
    } catch (mailErr) {
      console.error("❌ Nem sikerült elküldeni a kódot e-mailben:", mailErr);
      return res
        .status(500)
        .json({ success: false, error: "Nem sikerült elküldeni a belépési kódot e-mailben" });
    }

    // visszaszólunk a frontendnek: most kérd be a kódot
    return res.json({
      success: true,
      step: "code_required",
      message: "Belépési kód elküldve az e-mail címre.",
    });
  } catch (err) {
    console.error("Login hiba:", err);
    return res.status(500).json({ success: false, error: "Hiba történt a belépés során" });
  }
});

// 2️⃣ /api/verify-code
// - frontend elküldi: email + code
// - ha jó: JWT token generálás, visszaadjuk
app.post("/api/verify-code", async (req, res) => {
  const { email, code } = req.body;

  // megkeressük a memóriában
  const record = consumeCode(email);
  if (!record) {
    return res.status(400).json({ success: false, error: "Nincs aktív kód ehhez az e-mailhez vagy lejárt" });
  }

  if (record.code !== code) {
    return res.status(400).json({ success: false, error: "Érvénytelen kód" });
  }

  // kód rendben → JWT
  const token = jwt.sign(
    {
      email,
      userId: record.userId,
      role: record.role,
      location_id: record.location_id || null,
    },
    process.env.JWT_SECRET as string,
    { expiresIn: "8h" } // pl. 8 óra
  );

  return res.json({
    success: true,
    token,
    role: record.role,
    location_id: record.location_id || null,
  });
});

// itt mennek tovább a többi route-ok is...
// pl. app.use("/api/menus", menuRoutes); stb.

app.listen(3001, () => {
  console.log("✅ Backend fut a 3000-es porton");
});

// ===========================================================
// 🧭 IRÁNYÍTÓPULT / DASHBOARD
// ===========================================================
app.use("/api/dashboard", dashboardRoutes); // ✅ Dashboard route

// ===========================================================
// 🏢 LOCATIONS (SZALONOK / TELEPHELYEK)
// ===========================================================
app.use("/api/locations", locationsRoutes);

// ===========================================================
// 👤 AUTHENTIKÁCIÓ (REGISZTRÁCIÓ / LOGIN / 2FA)
// ===========================================================
app.post("/api/register", async (req, res) => {
  const { full_name, email, password } = req.body;
  if (!full_name || !email || !password)
    return res.status(400).json({ error: "Hiányzó adatok" });

  try {
    const exists = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    if (exists.rows.length > 0)
      return res.status(400).json({ error: "E-mail már létezik" });

    const password_hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (full_name, email, password_hash, role, active)
       VALUES ($1,$2,$3,'worker',TRUE)
       RETURNING id, full_name, email, role`,
      [full_name, email, password_hash]
    );

    res.status(201).json({
      message: "✅ Sikeres regisztráció",
      user: result.rows[0],
    });
  } catch (err) {
    console.error("❌ Regisztrációs hiba:", err);
    res.status(500).json({ error: "Adatbázis hiba" });
  }
});

app.post("/api/login", async (req, res) => {
  const { email, password, salon_id } = req.body;

  try {
    const result = await pool.query(
      "SELECT id, email, full_name, password_hash, role, active FROM users WHERE email=$1",
      [email]
    );

    if (result.rows.length === 0)
      return res.status(401).json({ success: false, error: "Hibás e-mail vagy jelszó" });

    const user = result.rows[0];
    if (!user.active)
      return res.status(403).json({ success: false, error: "Fiók inaktív" });

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch)
      return res.status(401).json({ success: false, error: "Hibás jelszó" });

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, salon_id },
      process.env.JWT_SECRET || "secret",
      { expiresIn: "8h" }
    );

    res.json({
      success: true,
      message: "Sikeres bejelentkezés",
      token,
      user,
    });
  } catch (err) {
    console.error("❌ Belépési hiba:", err);
    res.status(500).json({ error: "Adatbázis hiba" });
  }
});

app.post("/api/verify-code", (req, res) => {
  const { code } = req.body;
  if (code === "123456") {
    res.json({ success: true, message: "✅ Kód elfogadva" });
  } else {
    res.status(400).json({ success: false, error: "Érvénytelen kód" });
  }
});

// ===========================================================
// 🧭 MENÜRENDSZER
// ===========================================================
app.get("/api/menus", async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, route, icon, parent_id, required_role
      FROM menus
      ORDER BY id;
    `);

    const menus: any[] = [];

    result.rows.forEach((row: any) => {
      if (!row.parent_id) {
        menus.push({
          id: row.id,
          name: row.name,
          route: row.route,
          icon: row.icon,
          required_role: row.required_role,
          submenus: [],
        });
      } else {
        const parent = menus.find((m) => m.id === row.parent_id);
        if (parent) {
          parent.submenus.push({
            id: row.id,
            name: row.name,
            route: row.route,
            required_role: row.required_role,
          });
        }
      }
    });

    res.json(menus);
  } catch (err) {
    console.error("❌ Menü lekérési hiba:", err);
    res.status(500).json({ error: "Hiba a menük lekérése során" });
  }
});

// ===========================================================
// 🧾 MUNKALAP / FOGLALÁS / PÉNZÜGY
// ===========================================================
app.use("/api/workorders", workOrderRoutes);
app.use("/api/bookings", bookingsRoutes);
app.use("/api/transactions", transactionsRoutes);

// ===========================================================
// 🚀 SERVER INDÍTÁS
// ===========================================================
const server = app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`❌ Port ${PORT} már használatban van.`);
  } else {
    console.error(err);
  }
});
