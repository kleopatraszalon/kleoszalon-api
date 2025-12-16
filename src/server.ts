/* ===== .env betöltése AZONNAL ===== */
import dotenv from "dotenv";
dotenv.config();

import pool from "./db";
import express, { Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import jwt, { JwtPayload } from "jsonwebtoken";
import crypto from "crypto";
import cors, { CorsOptions } from "cors";
import path from "path";

/* ===== ROUTES (nem auth) ===== */
import menuRoutes from "./routes/menu";
/* import meRoutes from "./routes/me"; */
import workorderRoutes from "./routes/workorders";
import bookingsRoutes from "./routes/bookings";
import transactionsRoutes from "./routes/transactions";
import locationsRoutes from "./routes/locations";
import dashboardRoutes from "./routes/dashboard";
import employeesRouter from "./routes/employees";
import servicesRouter from "./routes/services";
import servicesAvailableRoutes from "./routes/services_available";
import employeeCalendarRoutes from "./routes/employee_calendar";
import scheduleDayRoutes from "./routes/schedule_day";
import appointmentsRouter from "./routes/appointments";
import authRouter from "./routes/auth"; // auth route-ok

import sendLoginCodeEmail from "./mailer";
import { saveCodeForEmail, consumeCode } from "./tempCodeStore";
import publicMarketingRouter from "./routes/publicMarketing";
import serviceTypesRouter from "./routes/serviceTypes";

import productsRouter from "./routes/products";
import productGroupsRouter from "./routes/productGroups";
import productCategoriesRouter from "./routes/productCategories";

import publicWebshopRouter from "./routes/publicWebshop";
import adminWebshopRouter from "./routes/adminWebshop";

const app = express();

/**
 * Render / reverse proxy mögött fut a szerver.
 * Secure cookie-k + helyes IP/proto detektálás miatt ajánlott.
 */
app.set("trust proxy", 1);

console.log("🔧 NODE_ENV:", process.env.NODE_ENV);
console.log("🔧 CORS_ORIGIN:", process.env.CORS_ORIGIN);

/* ===== CORS – credentiales (cookie-s) kérésekhez is helyes beállítás ===== */

const defaultAllowedOrigins = [
  "https://kleoszalon-frontend.onrender.com",
  "https://weblap-o3g6.onrender.com",

  // dev
  "http://localhost:5173",
  "http://localhost:3000",
  "http://localhost:3001",
];

// Opcionálisan engedj további origin(eke)t env-ből (pl. Render preview URL-ek)
const envAllowedOrigins = (process.env.CORS_ORIGIN ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const allowedOrigins = Array.from(new Set([...defaultAllowedOrigins, ...envAllowedOrigins]));

const corsOptions: CorsOptions = {
  origin: (origin, cb) => {
    // Postman/curl/server-to-server esetén origin lehet undefined → engedjük
    if (!origin) return cb(null, true);

    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked for origin: ${origin}`), false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  maxAge: 86400,
};

// CORS MINDIG a route-ok előtt!
app.use(cors(corsOptions));

// Preflight (OPTIONS) globálisan – így nem lesz 404 és biztosan lesznek CORS headerek
app.options("*", cors(corsOptions));

// Vary: Origin – cache korrekt működéséhez
app.use((_, res, next) => {
  res.header("Vary", "Origin");
  next();
});

// JSON + sütik (szintén route-ok előtt)
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

/* ===== Statikus feltöltések, hogy a weblap is elérje a képeket ===== */
app.use("/uploads", express.static(path.join(__dirname, "..", "uploads")));

// PUBLIC WEBSHOP
app.use("/api/public/webshop", publicWebshopRouter);

// ADMIN WEBSHOP (ide később érdemes auth middleware-t rakni, pl. verifyAdmin)
app.use("/api/admin/webshop", adminWebshopRouter);

/* ===== JWT segédek ===== */

const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";
const AUTH_ACCEPT_PLAINTEXT_DEV =
  process.env.AUTH_ACCEPT_PLAINTEXT_DEV === "1";
const DEBUG_AUTH = process.env.DEBUG_AUTH === "1";

function signToken(payload: object) {
  return jwt.sign(payload as any, JWT_SECRET, { expiresIn: "8h" });
}
function extractBearer(req: Request): string | null {
  const h = (req.headers["authorization"] ||
    req.headers["Authorization"]) as string | undefined;
  return h && /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, "") : null;
}
function extractTokenFromReq(req: Request): string | null {
  return (
    extractBearer(req) ||
    (req as any).cookies?.token ||
    (req.query?.token as string) ||
    (req.body?.token as string) ||
    null
  );
}

interface AuthTokenPayload extends JwtPayload {
  id: string;
  email: string;
  role?: string;
  location_id?: string | null;
}

function getUserIdFromReq(req: Request): string | null {
  const token = extractTokenFromReq(req);
  if (!token) return null;

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as AuthTokenPayload;
    return decoded.id ?? null;
  } catch (err) {
    if (DEBUG_AUTH) {
      console.warn("⚠️ JWT decode error in getUserIdFromReq:", err);
    }
    return null;
  }
}

function getLocationIdFromReq(req: Request): string | null {
  const token = extractTokenFromReq(req);
  if (!token) return null;

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as AuthTokenPayload;
    return decoded.location_id ?? null;
  } catch (err) {
    if (DEBUG_AUTH) {
      console.warn("⚠️ JWT decode error in getLocationIdFromReq:", err);
    }
    return null;
  }
}

/* ===== Hash detektálás + ellenőrzés ===== */
type HashType = "bcrypt" | "argon2" | "pbkdf2" | "sha256" | "plaintext" | "unknown";

function detectHashType(hash: string | null | undefined): HashType {
  if (!hash) return "unknown";
  if (hash.startsWith("$2a$") || hash.startsWith("$2b$") || hash.startsWith("$2y$"))
    return "bcrypt";
  if (hash.startsWith("$argon2")) return "argon2";
  if (hash.startsWith("pbkdf2$")) return "pbkdf2";
  if (hash.startsWith("sha256:")) return "sha256";
  if (hash.length > 0 && hash.length < 60) return "plaintext";
  return "unknown";
}

async function verifyPassword(
  stored: string | null | undefined,
  plain: string
): Promise<boolean> {
  const t = detectHashType(stored);
  if (DEBUG_AUTH) {
    console.log("🔐 Hash type:", t, "stored length:", stored?.length);
  }

  if (!stored) return false;

  if (t === "bcrypt") {
    return bcrypt.compare(plain, stored);
  }

  if (t === "sha256") {
    const [, hashPart] = stored.split(":", 2);
    const hash = crypto.createHash("sha256").update(plain, "utf8").digest("hex");
    return hash === hashPart;
  }

  if (t === "plaintext") {
    if (!AUTH_ACCEPT_PLAINTEXT_DEV && process.env.NODE_ENV === "production") {
      // Productionban NEM fogadunk el plaintext jelszót
      return false;
    }
    return stored === plain;
  }

  // Egyéb ismeretlen/argon/pbkdf2 esetén most nem támogatjuk
  return false;
}

/* ====== Belépés (1. lépcső: jelszó + kód küldés) ====== */

async function loginHandler(req: Request, res: Response) {
  const { email, login_name, password, location_id } = (req.body ?? {}) as {
    email?: string;
    login_name?: string;
    password?: string;
    location_id?: any;
  };

  const identRaw = email || login_name || "";
  const ident = identRaw.trim().toLowerCase();

  if (!ident || !password) {
    return res.status(400).json({
      success: false,
      error: "Hiányzó e-mail/felhasználónév vagy jelszó",
    });
  }

  try {
    // Csak biztosan létező oszlopokat kérünk le
    const { rows } = await pool.query(
      `
      SELECT id, email, password_hash, role, location_id, full_name
      FROM users
      WHERE lower(email) = lower($1)
      LIMIT 1
      `,
      [ident]
    );

    if (rows.length === 0) {
      console.warn(`[AUTH] user not found: ${ident}`);
      return res
        .status(401)
        .json({ success: false, error: "Érvénytelen felhasználónév/jelszó" });
    }

    const user: any = rows[0];

    const ok = await verifyPassword(user.password_hash, password);
    if (!ok) {
      console.warn(`[AUTH] bad password for: ${ident}`);
      return res
        .status(401)
        .json({ success: false, error: "Érvénytelen felhasználónév/jelszó" });
    }

    const resolvedLocationId =
      typeof location_id !== "undefined" && location_id !== null
        ? location_id
        : user.location_id ?? null;

    const payload: AuthTokenPayload = {
      id: String(user.id),
      email: String(user.email),
      role: user.role ?? "guest",
      location_id: resolvedLocationId ?? null,
    };

    const token = signToken(payload);

    res.cookie("token", token, {
      httpOnly: true,
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 8 * 60 * 60 * 1000,
    });

    return res.json({
      success: true,
      token,
      role: user.role ?? "guest",
      location_id: resolvedLocationId,
      full_name: user.full_name ?? null,
      email: user.email ?? null,
    });
  } catch (err) {
    console.error("❌ Login hiba:", err);
    return res
      .status(500)
      .json({ success: false, error: "Hiba történt a belépés során" });
  }
}

/* ====== Kód ellenőrzés (2. lépcső) – JWT ====== */

async function verifyCodeHandler(req: Request, res: Response) {
  const { email, login_name, code, location_id, mode } =
    (req.body ?? {}) as {
      email?: string;
      login_name?: string;
      code?: string;
      location_id?: any;
      mode?: string;
    };

  // 1) E-mail normalizálás
  let emailKey = String(email ?? "").trim().toLowerCase();

  // Ha nincs e-mail, de van login_name (azonosító), megpróbáljuk e-mailre feloldani
  if (!emailKey && login_name) {
    try {
      const ident = String(login_name).trim().toLowerCase();
      const r = await pool.query(
        `
        SELECT email
        FROM users
        WHERE lower(email) = $1
        LIMIT 1
      `,
        [ident]
      );
      if (r.rows.length) {
        emailKey = String(r.rows[0].email || "").toLowerCase();
      }
    } catch (err) {
      console.error("❌ verifyCodeHandler - e-mail feloldási hiba:", err);
    }
  }

  if (!emailKey || !code) {
    return res.status(400).json({
      success: false,
      error: "Hiányzó e-mail és/vagy kód",
    });
  }

  const record = consumeCode(emailKey);
  if (!record) {
    return res.status(400).json({
      success: false,
      error: "Nincs aktív kód ehhez az e-mailhez vagy lejárt",
    });
  }

  if (record.code !== String(code)) {
    return res
      .status(400)
      .json({ success: false, error: "Érvénytelen kód" });
  }

  // 3) JWT felépítése
  const token = signToken({
    id: record.userId,
    email: emailKey,
    role: record.role,
    location_id:
      (mode === "customer"
        ? location_id ?? record.location_id
        : record.location_id) ?? null,
  });

  // 4) Token sütiben is, plusz JSON-ben vissza
  res.cookie("token", token, {
    httpOnly: true,
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 8 * 60 * 60 * 1000, // 8 óra
  });

  return res.json({
    success: true,
    token,
    role: record.role,
    location_id:
      (mode === "customer"
        ? location_id ?? record.location_id
        : record.location_id) ?? null,
  });
}

// FELÜL: itt már legyen importálva a pool
// import pool from "./db";  <-- ezt valószínűleg már használod máshol

/* ===== /api/me – bejelentkezett felhasználó adatai ===== */
app.get("/api/me", async (req: Request, res: Response) => {
  try {
    const token = extractTokenFromReq(req);
    if (!token) {
      return res
        .status(401)
        .json({ success: false, error: "Nincs bejelentkezett felhasználó (hiányzó token)." });
    }

    let decoded: any;
    try {
      decoded = jwt.verify(token, JWT_SECRET) as AuthTokenPayload;
    } catch (err) {
      if (DEBUG_AUTH) {
        console.warn("⚠️ JWT decode error in /api/me:", err);
      }
      return res
        .status(401)
        .json({ success: false, error: "Érvénytelen vagy lejárt token." });
    }

    const userId = decoded.id || decoded.userId || decoded.user_id;
    if (!userId) {
      return res
        .status(401)
        .json({ success: false, error: "A token nem tartalmaz felhasználó azonosítót." });
    }

    const { rows } = await pool.query(
      `
      SELECT id, email, role, full_name, location_id
      FROM users
      WHERE id = $1
      LIMIT 1
      `,
      [userId]
    );

    if (rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, error: "A felhasználó nem található." });
    }

    const user = rows[0];

    return res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        full_name: user.full_name ?? null,
        location_id: user.location_id ?? null,
      },
    });
  } catch (err) {
    console.error("❌ /api/me hiba:", err);
    return res
      .status(500)
      .json({ success: false, error: "Hiba történt a felhasználói adatok lekérése közben." });
  }
});

/* ===== API ROUTE-OK REGISZTRÁLÁSA ===== */

// Étlap / menü
app.use("/api/menu", menuRoutes);
app.use("/api/menus", menuRoutes);
// app.use("/api/me", meRoutes);
app.use("/api/workorders", workorderRoutes);
app.use("/api/bookings", bookingsRoutes);
app.use("/api/transactions", transactionsRoutes);
app.use("/api/locations", locationsRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/employees", employeesRouter);
app.use("/api/services", servicesRouter);
app.use("/api/services-available", servicesAvailableRoutes);
app.use("/api/employee-calendar", employeeCalendarRoutes);
app.use("/api/schedule/day", scheduleDayRoutes);
app.use("/api/appointments", appointmentsRouter);
app.use("/api/public", publicMarketingRouter);
app.use("/api/service-types", serviceTypesRouter);

// Szalon lista a webshop/marketing oldalhoz
app.get("/api/locations", async (_req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        id,
        name,
        city
      FROM locations
      WHERE is_active = TRUE
      ORDER BY city, name;
      `
    );

    return res.json({ items: result.rows });
  } catch (err) {
    console.error("❌ Szalon lekérési hiba:", err);
    res.status(500).json({ error: "Szalon lekérési hiba" });
  }
});

app.use("/api/products", productsRouter);
app.use("/api/product-groups", productGroupsRouter);
app.use("/api/product-categories", productCategoriesRouter);

// Auth saját végpontok (ha a routes/auth mellett is kell):
app.post("/api/auth/login", loginHandler);
app.post("/api/auth/verify-code", verifyCodeHandler);

// Router alapú auth (ha ott vannak további route-ok)
app.use("/api/auth", authRouter);

/* ===== Globális hiba-kezelő ===== */
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("❌ Unhandled error:", err);
  res.status(500).json({ error: "Szerver hiba" });
});

/* ===== Szerver indítása ===== */

const port = process.env.PORT || 5000;
const server = app.listen(port, () => {
  console.log(`🚀 API szerver fut a(z) ${port} porton`);
});

// Graceful shutdown
server.on("error", (err: any) => {
  if (err.code === "EADDRINUSE")
    console.error(`❌ Port ${port} már használatban van.`);
  else console.error(err);
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