import "dotenv/config";
import express, { Request, Response } from "express";
import cors, { CorsOptions } from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pool from "./db";

import meRoutes from "./routes/me";
import workOrderRoutes from "./routes/workorders";
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

// CORS – .env CORS_ORIGIN támogatás (vesszővel elválasztva). Ha nincs megadva, minden engedélyezett.
const allowedOrigins = (process.env.CORS_ORIGIN ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const corsOptions: CorsOptions = {
  // Ha van lista és nem tartalmaz '*', akkor azt használjuk; különben origin: true (reflektálja a kérést)
  origin: allowedOrigins.length > 0 && !allowedOrigins.includes("*") ? allowedOrigins : true,
  // Ha '*' szerepel, ne küldjünk hitelesítési adatokat (böngészőkorlát). Egyébként engedjük.
  credentials: allowedOrigins.length > 0 ? !allowedOrigins.includes("*") : true,
};

app.use(cors(corsOptions));

// (opcionális Render/Proxy): helyes IP és protokoll felismerés
app.set("trust proxy", 1);

// ===== Health (Render health check) =====
app.get("/health", (_req: Request, res: Response) => res.status(200).send("ok"));

// ===== Teszt gyökér =====
app.get("/", (_req: Request, res: Response) => {
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
app.post("/api/login", async (req: Request, res: Response) => {
  const { email, password } = req.body as { email: string; password: string };

  try {
    const result = await pool.query(
      "SELECT id, email, password_hash, role, location_id, active FROM users WHERE email = $1",
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, error: "Hibás e-mail vagy jelszó" });
    }

    const user = result.rows[0];
    if (!user.active) {
      return res.status(403).json({ success: false, error: "Fiók inaktív" });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ success: false, error: "Hibás e-mail vagy jelszó" });
    }

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
app.post("/api/verify-code", (req: Request, res: Response) => {
  const { email, code } = req.body as { email: string; code: string };
  const record = consumeCode(email);

  if (!record) {
    return res
      .status(400)
      .json({ success: false, error: "Nincs aktív kód ehhez az e-mailhez vagy lejárt" });
  }

  if (record.code !== code) {
    return res.status(400).json({ success: false, error: "Érvénytelen kód" });
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    console.error("Hiányzó JWT_SECRET környezeti változó.");
    return res.status(500).json({ success: false, error: "Szerver beállítási hiba (JWT)" });
  }

  const token = jwt.sign(
    {
      email,
      userId: record.userId,
      role: record.role,
      location_id: record.location_id || null,
    },
    secret,
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
const port = Number(process.env.PORT ?? 3002);
const host = "0.0.0.0";
const server = app.listen(port, host, () => {
  console.log(`✅ Server running on http://${host}:${port}`);
});

// Port foglaltság/egyéb hiba kezelése – NodeJS típusok nélkül
interface ErrnoLike extends Error {
  code?: string;
}
server.on("error", (err: ErrnoLike) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(`❌ Port ${port} már használatban van.`);
  } else {
    console.error(err);
  }
});
