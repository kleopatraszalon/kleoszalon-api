// src/server.ts
import "dotenv/config";
import express from "express";
import cors from "cors";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import pool from "./db";

import meRoutes from "./routes/me";
import workOrderRoutes from "./routes/workOrders";
import bookingsRoutes from "./routes/bookings";
import transactionsRoutes from "./routes/transactions";
import locationsRoutes from "./routes/locations";
import dashboardRoutes from "./routes/dashboard";
import employeesRouter from "./routes/employees";
import servicesRouter from "./routes/services";
import servicesAvailableRoutes from "./routes/services_available";
import employeeCalendarRoutes from "./routes/employee_calendar";

import sendLoginCodeEmail from "./mailer";
import { saveCodeForEmail, consumeCode } from "./tempCodeStore";

const app = express();

// ===== Alap middleware-ek =====
app.use(express.json());
app.use(
  cors({
    origin: (process.env.CORS_ORIGIN?.split(",") ?? ["*"]),
    credentials: true,
  })
);

// ===== Health (Render health check) =====
app.get("/health", (_req, res) => res.status(200).send("ok"));

// ===== Teszt gyökér =====
app.get("/", (_req, res) => {
  res.send("✅ Backend fut és CORS be van állítva");
});

// ===== API route-ok =====
app.use("/api/me", meRoutes);
app.use("/api/employees", employeesRouter);
app.use("/api/services", servicesRouter);
app.use("/api/services/available", servicesAvailableRoutes);
app.use("/api/employee-calendar", employeeCalendarRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/locations", locationsRoutes);
app.use("/api/workorders", workOrderRoutes);
app.use("/api/bookings", bookingsRoutes);
app.use("/api/transactions", transactionsRoutes);

// ===== Auth: 1) /api/login → e-mail + jelszó → 2FA kód kiküldése =====
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await pool.query(
      "SELECT id, email, password_hash, role, location_id, active FROM users WHERE email = $1",
      [email]
    );

    if (result.rows.length === 0)
      return res.status(401).json({ success: false, error: "Hibás e-mail vagy jelszó" });

    const user = result.rows[0];
    if (!user.active)
      return res.status(403).json({ success: false, error: "Fiók inaktív" });

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch)
      return res.status(401).json({ success: false, error: "Hibás e-mail vagy jelszó" });

    // 6 jegyű kód generálása
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresMin = parseInt(process.env.CODE_EXPIRES_MIN || "5", 10);

    saveCodeForEmail(email, {
      code,
      userId: user.id,
      role: user.role || "guest",
      location_id: user.location_id || null,
      expiresAt: Date.now() + expiresMin * 60 * 1000,
    });

    // kód e-mailben
    await sendLoginCodeEmail(email, code);

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

// ===== Auth: 2) /api/verify-code → JWT kiadása, ha a kód stimmel =====
app.post("/api/verify-code", (req, res) => {
  const { email, code } = req.body;
  const record = consumeCode(email);

  if (!record)
    return res.status(400).json({ success: false, error: "Nincs aktív kód ehhez az e-mailhez vagy lejárt" });

  if (record.code !== code)
    return res.status(400).json({ success: false, error: "Érvénytelen kód" });

  const token = jwt.sign(
    {
      email,
      userId: record.userId,
      role: record.role,
      location_id: record.location_id || null,
    },
    process.env.JWT_SECRET as string,
    { expiresIn: "8h" }
  );

  return res.json({
    success: true,
    token,
    role: record.role,
    location_id: record.location_id || null,
  });
});

// ===== Indítás (EGY darab listen!) =====
const port = Number(process.env.PORT) || 3002; // lokálra 3002 jó
const host = "0.0.0.0";                         // Renderhez kell
const server = app.listen(port, host, () => {
  console.log(`✅ Server running on http://${host}:${port}`);
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`❌ Port ${port} már használatban van.`);
  } else {
    console.error(err);
  }
});
