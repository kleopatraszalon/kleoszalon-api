/* ===== .env betöltése az első sorban ===== */
import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import cors, { CorsOptions } from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pool from "./db.js";

// ROUTES
import menuRoutes from "./routes/menu.js";
import meRoutes from "./routes/me.js";
import workorderRoutes from "./routes/workorders.js";
import bookingsRoutes from "./routes/bookings.js";
import transactionsRoutes from "./routes/transactions.js";
import locationsRoutes from "./routes/locations.js";
import dashboardRoutes from "./routes/dashboard.js";
import employeesRouter from "./routes/employees.js";
import servicesRouter from "./routes/services.js";
import servicesAvailableRoutes from "./routes/services_available.js";
import employeeCalendarRoutes from "./routes/employee_calendar.js";

import sendLoginCodeEmail from "./mailer.js";
import { saveCodeForEmail, consumeCode } from "./tempCodeStore.js";

const app = express();

/* ===== Proxy és alap middlewares ===== */
app.set("trust proxy", 1);

// --- CORS előbb, mint bármely route! ---
const allowedOrigins =
  process.env.CORS_ORIGIN?.split(",").map((s) => s.trim()).filter(Boolean) || [];

const corsOptions: CorsOptions = {
  // Ha nincs megadva semmi, engedjük az összes origin-t (dev).
  // origin: true esetén a cors csomag visszatükrözi a kérést küldő origin-t.
  origin: allowedOrigins.length > 0 && !allowedOrigins.includes("*") ? allowedOrigins : true,
  credentials: allowedOrigins.length > 0 ? !allowedOrigins.includes("*") : true,
};

app.use(cors(corsOptions));
// Preflight kérelmek (OPTIONS) kezelése
app.options("*", cors(corsOptions));

app.use(express.json({ limit: "1mb" }));

/* ===== Health check ===== */
app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/* ===== Teszt root ===== */
app.get("/", (_req: Request, res: Response) => {
  res.send("✅ Backend fut és CORS be van állítva");
});

/* ===== Route-ok (MENÜ legfelül, alias-szal) ===== */
app.use("/api/menu", menuRoutes);   // => GET /api/menu
app.use("/api/menus", menuRoutes);  // alias, ha a frontend ezt hívja

app.use("/api/me", meRoutes);
app.use("/api/employees", employeesRouter);
app.use("/api/services", servicesRouter);
app.use("/api/services/available", servicesAvailableRoutes);
app.use("/api/employee-calendar", employeeCalendarRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/locations", locationsRoutes);
app.use("/api/workorders", workorderRoutes);
app.use("/api/bookings", bookingsRoutes);
app.use("/api/transactions", transactionsRoutes);

/* ===== Auth: Login ===== */
app.post("/api/login", async (req: Request, res: Response) => {
  const { email, password } = req.body as { email: string; password: string };

  if (!email || !password) {
    return res.status(400).json({ success: false, error: "Hiányzó e-mail vagy jelszó" });
  }

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

    // 🔹 6 jegyű kód generálása
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresMin = parseInt(process.env.CODE_EXPIRES_MIN || "5", 10);

    saveCodeForEmail(email, {
      code,
      userId: user.id,
      role: user.role || "guest",
      location_id: user.location_id || null,
      expiresAt: Date.now() + expiresMin * 60 * 1000,
    });

    console.log("📧 Küldés előtt – SMTP_USER:", process.env.SMTP_USER);
    await sendLoginCodeEmail(email, code);

    return res.json({
      success: true,
      step: "code_required",
      message: "Belépési kód elküldve az e-mail címre.",
    });
  } catch (err) {
    console.error("❌ Login hiba:", err);
    return res.status(500).json({ success: false, error: "Hiba történt a belépés során" });
  }
});

/* ===== Auth: Verify Code ===== */
app.post("/api/verify-code", (req: Request, res: Response) => {
  const { email, code } = req.body as { email: string; code: string };
  const record = consumeCode(email);

  if (!record) {
    return res.status(400).json({
      success: false,
      error: "Nincs aktív kód ehhez az e-mailhez vagy lejárt",
    });
  }

  if (record.code !== code) {
    return res.status(400).json({ success: false, error: "Érvénytelen kód" });
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    console.error("❌ Hiányzó JWT_SECRET környezeti változó.");
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

/* ===== 404 Not Found ===== */
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: "Not found", path: req.originalUrl });
});

/* ===== Globális hiba-kezelő ===== */
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("❌ Unhandled error:", err);
  res.status(500).json({ error: "Szerver hiba" });
});

/* ===== Indítás ===== */
const port = Number(process.env.PORT) || 5000;
const host = process.env.HOST || "0.0.0.0";

const server = app.listen(port, host, () => {
  console.log(`✅ Server running on http://${host}:${port}`);
});

// Stabilabb hálózat Renderen / proxy mögött
// (lásd: "Bad Gateway" tippek)
server.keepAliveTimeout = 120_000;
server.headersTimeout = 120_000;

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`❌ Port ${port} már használatban van.`);
  } else {
    console.error(err);
  }
});

// Graceful shutdown
const shutdown = () => {
  console.log("🛑 Leállítás folyamatban...");
  server.close(() => {
    console.log("👋 Szerver leállt.");
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

export default app;
