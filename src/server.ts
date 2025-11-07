/* ===== .env betöltése AZONNAL ===== */
import dotenv from "dotenv";
dotenv.config();

import express, { Request, Response, NextFunction } from "express";
import cors, { CorsOptions } from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pool from "./db";

/* ===== ROUTES ===== */
import menuRoutes from "./routes/menu";
import meRoutes from "./routes/me";
import workorderRoutes from "./routes/workorders";
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

/* ===== Proxy és alap middlewares ===== */
app.set("trust proxy", 1);

/* ===== CORS – rugalmas, hibatűrő, wildcard támogatással ===== */
const rawOrigins = ((process.env.CORS_ORIGIN ?? "*")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean));

const allowAll = rawOrigins.includes("*") || rawOrigins.length === 0;

// egyszerű wildcard illesztő: '*' → bármi, '*.domain.hu' → bármely aldomain
function originMatches(origin: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (p === "*") return true;
    const re = new RegExp(
      "^" +
        p
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&") // escape
          .replace(/\\\*/g, ".*") +               // '*' → '.*'
      "$"
    );
    if (re.test(origin)) return true;
  }
  return false;
}

const corsOptions: CorsOptions = {
  origin(origin, cb) {
    // No-origin (pl. Postman/cURL) → engedjük
    if (!origin) return cb(null, true);

    // Mindent engedünk (dev / '*' / nincs megadva)
    if (allowAll) return cb(null, true);

    // Ha megegyezik valamely mintával → engedjük
    if (originMatches(origin, rawOrigins)) return cb(null, true);

    // NINCS hiba dobás! Egyszerűen nem teszünk CORS headert.
    return cb(null, false);
  },
  credentials: true,
  optionsSuccessStatus: 204,
};

// Vary: Origin – hogy a cache helyesen kezelje az origin alapú variációt
app.use((_, res, next) => {
  res.header("Vary", "Origin");
  next();
});

app.use(cors(corsOptions));
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

/* ===== Route-ok mountolása ===== */
app.use("/api/menu", menuRoutes);
app.use("/api/menus", menuRoutes);

app.use("/api/me", meRoutes);
app.use("/api/employees", employeesRouter);

/* FONTOS: specifikus előbb, mint a generikus */
app.use("/api/services/available", servicesAvailableRoutes);
app.use("/api/services", servicesRouter);

app.use("/api/employee-calendar", employeeCalendarRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/locations", locationsRoutes);
app.use("/api/workorders", workorderRoutes);
app.use("/api/bookings", bookingsRoutes);
app.use("/api/transactions", transactionsRoutes);

/* ===== Auth: Login (1. lépcső – jelszó + e-mail kód) ===== */
app.post("/api/login", async (req: Request, res: Response) => {
  const { email, password } = (req.body ?? {}) as { email?: string; password?: string };

  if (!email || !password) {
    return res.status(400).json({ success: false, error: "Hiányzó e-mail vagy jelszó" });
  }

  try {
    const result = await pool.query(
      `SELECT id, email, password_hash, role, location_id, active
       FROM users
       WHERE email = $1`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, error: "Hibás e-mail vagy jelszó" });
    }

    const user = result.rows[0];

    if (!user.active) {
      return res.status(403).json({ success: false, error: "Fiók inaktív" });
    }

    const isMatch = bcrypt.compareSync(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ success: false, error: "Hibás e-mail vagy jelszó" });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresMin = Number.parseInt(process.env.CODE_EXPIRES_MIN || "5", 10);

    saveCodeForEmail(email, {
      code,
      userId: user.id,
      role: user.role ?? "guest",
      location_id: user.location_id ?? null,
      expiresAt: Date.now() + expiresMin * 60 * 1000,
    });

    try {
      await sendLoginCodeEmail(email, code);
    } catch (mailErr) {
      console.error("❌ E-mail küldési hiba:", mailErr);
      // Ha nem sikerült elküldeni, ne írjuk ki a kódot – inkább hibázzunk
      return res.status(500).json({ success: false, error: "Nem sikerült elküldeni a belépési kódot" });
    }

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

/* ===== Auth: Verify Code (2. lépcső – JWT) ===== */
app.post("/api/verify-code", (req: Request, res: Response) => {
  const { email, code } = (req.body ?? {}) as { email?: string; code?: string };

  if (!email || !code) {
    return res.status(400).json({ success: false, error: "Hiányzó e-mail vagy kód" });
  }

  const record = consumeCode(email);
  if (!record) {
    return res.status(400).json({
      success: false,
      error: "Nincs aktív kód ehhez az e-mailhez vagy lejárt",
    });
  }

  if (record.code !== String(code)) {
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
      location_id: record.location_id ?? null,
    },
    secret,
    { expiresIn: "8h" }
  );

  return res.json({
    success: true,
    token,
    role: record.role,
    location_id: record.location_id ?? null,
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

server.keepAliveTimeout = 120_000;
server.headersTimeout = 120_000;

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`❌ Port ${port} már használatban van.`);
  } else {
    console.error(err);
  }
});

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
