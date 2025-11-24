/* ===== .env betöltése AZONNAL ===== */
import dotenv from "dotenv";
dotenv.config();
import pool from "./db";
import express, { Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import jwt, { JwtPayload } from "jsonwebtoken";
import crypto from "crypto";
import cors from "cors";



/* ===== ROUTES (nem auth) ===== */
import menuRoutes from "./routes/menu";
/*  import meRoutes from "./routes/me"; */
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
import authRouter from "./routes/auth";  // auth route-ok

import sendLoginCodeEmail from "./mailer";
import { saveCodeForEmail, consumeCode } from "./tempCodeStore";
import publicMarketingRouter from "./routes/publicMarketing";

import App from "./app";
import serviceTypesRouter from "./routes/serviceTypes";

import productsRouter from "./routes/products";
import productGroupsRouter from "./routes/productGroups";
import productCategoriesRouter from "./routes/productCategories";
import path from "path";
import publicWebshopRouter from "./routes/publicWebshop";
import adminWebshopRouter from "./routes/adminWebshop";
import publicWebshopRoutes from "./routes/publicWebshop";
import authRoutes from "./routes/auth";

const app = express();



console.log("🧩 SMTP_USER:", process.env.SMTP_USER || "NINCS beállítva");
console.log("🧩 SMTP_PASS:", process.env.SMTP_PASS ? "✅ van" : "❌ hiányzik");



app.use(express.json());
app.use(cookieParser());

// CORS – ahogy eddig is
app.use(cors({
  origin: function (origin, callback) {
    // Ha nincs origin (pl. szerver-szerver kommunikáció vagy Postman), engedélyezzük
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) === -1) {
      var msg = 'A CORS házirend nem engedélyezi a hozzáférést erről az eredetről.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  credentials: true // Ha sütiket vagy hitelesítést is használsz
}));

app.use("/api", authRoutes);

/* ===== Proxy és alap middlewares ===== */
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin || "*";

  res.header("Access-Control-Allow-Origin", origin);
  res.header("Vary", "Origin"); // cache miatt fontos
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization"
  );
  res.header(
    "Access-Control-Allow-Methods",
    "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS"
  );
  res.header("Access-Control-Allow-Credentials", "true");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json());
app.use(cookieParser());
app.set("trust proxy", 1);

// statikus feltöltések, hogy a weblap is elérje a képeket
app.use(
  "/uploads",
  express.static(path.join(__dirname, "..", "uploads"))
);

// PUBLIC WEBSHOP
app.use("/api/public/webshop", publicWebshopRouter);
app.use("/api/public/webshop", publicWebshopRoutes);

// ADMIN WEBSHOP (itt érdemes auth middleware-t rakni, pl. verifyAdmin)
app.use("/api/admin/webshop", /* verifyAdmin, */ adminWebshopRouter);
// Webshop admin API
app.use("/api/admin/webshop", adminWebshopRouter);
app.use(
  "/uploads",
  express.static(path.join(__dirname, "..", "uploads"))
);


const allowedOrigins = [
   "http://localhost:3000",
   "http://localhost:3001",
   "https://kleoszalon-frontend.onrender.com/login", // IDE a Render frontend pontos URL-je
 ];

app.use(cors({
  origin: function (origin, callback) {
    // Ha nincs origin (pl. szerver-szerver kommunikáció vagy Postman), engedélyezzük
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) === -1) {
      var msg = 'A CORS házirend nem engedélyezi a hozzáférést erről az eredetről.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  credentials: true // Ha sütiket vagy hitelesítést is használsz
}));

// Adatbázis kapcsolat
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // Render PostgreSQL-hez szükséges lehet
  },
});

// Teszt végpont
app.get("/", (req, res) => {
  res.send("A Kleoszalon API fut! 🚀");
});

// Példa API végpont: Telephelyek lekérése (a hibaüzeneted alapján ez hiányzott)
app.get("/api/locations", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM locations"); // Feltételezve, hogy van 'locations' tábla
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Szerver hiba az adatok lekérésekor" });
  }
});

app.listen(port, () => {
  console.log(`Szerver fut a ${port}-es porton`);
});
/* ===== CORS – rugalmas, wildcard támogatás ===== */
const rawOrigins = ((process.env.CORS_ORIGIN ?? "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean));
const allowAll = rawOrigins.includes("*") || rawOrigins.length === 0;

function originMatches(origin: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (p === "*") return true;
    const re = new RegExp("^" + p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*") + "$");
    if (re.test(origin)) return true;
  }
  return false;
}
app.use("/api/schedule/day", scheduleDayRoutes);

app.get("/api/locations", async (_req, res) => {
  try {
 const result = await pool.query(
      `
      SELECT
        id,
        name,
        address,
        city,
        phone,
        true AS active
      FROM public.locations
      ORDER BY city, name;
      `
    );

    res.json({ items: result.rows });
  } catch (err) {
    console.error("❌ Szalon lekérési hiba:", err);
    res.status(500).json({ error: "Szalon lekérési hiba" });
  }
});

app.use("/api/products", productsRouter);
app.use("/api/product-groups", productGroupsRouter);
app.use("/api/product-categories", productCategoriesRouter);


/*const corsOptions: CorsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (allowAll) return cb(null, true);
    if (originMatches(origin, rawOrigins)) return cb(null, true);
    return cb(null, false);
  },
  credentials: true,
  optionsSuccessStatus: 204,
};

app.use((_, res, next) => { res.header("Vary", "Origin"); next(); });
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

/* ===== JWT segédek ===== */

app.use((req, res, next) => {
  const origin = req.headers.origin || "*";
  res.header("Access-Control-Allow-Origin", origin); // vagy fix: https://kleoszalon-frontend.onrender.com
  res.header("Vary", "Origin");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  res.header("Access-Control-Allow-Methods", "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json());
app.use(cookieParser());

const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";
const AUTH_ACCEPT_PLAINTEXT_DEV = process.env.AUTH_ACCEPT_PLAINTEXT_DEV === "1";
const DEBUG_AUTH = process.env.DEBUG_AUTH === "1";

function signToken(payload: object) {
  return jwt.sign(payload as any, JWT_SECRET, { expiresIn: "8h" });
}
function extractBearer(req: Request): string | null {
  const h = (req.headers["authorization"] || req.headers["Authorization"]) as string | undefined;
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
/* ===== JWT payload segédtípus + location_id kinyerése ===== */
interface AuthTokenPayload extends JwtPayload {
  id: string;
  email: string;
  role: string;
  location_id?: string;
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
  if (hash.startsWith("$2a$") || hash.startsWith("$2b$") || hash.startsWith("$2y$")) return "bcrypt";
  if (hash.startsWith("$argon2")) return "argon2";
  if (hash.startsWith("pbkdf2$")) return "pbkdf2";
  if (hash.startsWith("sha256:")) return "sha256";
  if (hash.length > 0 && hash.length < 60) return "plaintext";
  return "unknown";
}

async function verifyPassword(stored: string | null | undefined, plain: string): Promise<boolean> {
  const t = detectHashType(stored);
  const s = stored || "";

  try {
    switch (t) {
      case "bcrypt":
        return bcrypt.compareSync(plain, s);

      case "argon2":
        try {
          // opcionális csomag: npm i argon2
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const argon2 = require("argon2");
          return await argon2.verify(s, plain);
        } catch {
          console.warn("⚠️ Argon2 hash és 'argon2' csomag nincs telepítve. (npm i argon2)");
          return false;
        }

      case "pbkdf2": {
        // formátum: pbkdf2$ITER$SALT$HEX
        const parts = s.split("$");
        if (parts.length !== 4) return false;
        const iter = parseInt(parts[1], 10) || 100000;
        const salt = parts[2];
        const hex = parts[3];
        const derived = crypto
          .pbkdf2Sync(plain, salt, iter, hex.length / 2, "sha256")
          .toString("hex");
        return crypto.timingSafeEqual(
          Buffer.from(hex, "hex"),
          Buffer.from(derived, "hex")
        );
      }

      case "sha256": {
        const hex = s.slice("sha256:".length);
        const digest = crypto.createHash("sha256").update(plain).digest("hex");
        return crypto.timingSafeEqual(
          Buffer.from(hex, "hex"),
          Buffer.from(digest, "hex")
        );
      }

      case "plaintext":
        return AUTH_ACCEPT_PLAINTEXT_DEV ? s === plain : false;

      default:
        return AUTH_ACCEPT_PLAINTEXT_DEV ? s === plain : false;
    }
  } catch (e) {
    console.error("❌ verifyPassword error:", e);
    return false;
  }
}




// Telephelyek listázása
app.get("/api/locations", async (_req, res) => {
  try {
    // TODO: itt állítsd be a SAJÁT táblád nevét és mezőit!

    // 1) Ha van külön locations tábla:
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

    return res.json(result.rows);
  } catch (err: any) {
    console.error("GET /api/locations error:", err);

    // ⬇ FEJLESZTÉSI fallback – hogy a frontend MOST azonnal működjön
    if (process.env.NODE_ENV !== "production") {
      return res.json([
        { id: "demo-1", name: "Budapest – Kleopátra Központ" },
        { id: "demo-2", name: "Gödöllő – Kleopátra Szalon" },
      ]);
    }

    // élesben maradjon a 500
    return res.status(500).json({
      success: false,
      error: "Nem sikerült lekérni a telephelyeket.",
    });
  }
});
/* ===== Health + root ===== */
app.get("/api/health", (_req, res) =>
  res.json({ ok: true, time: new Date().toISOString() })
);
app.get("/", (_req, res) =>
  res.send("✅ Backend fut és CORS be van állítva")
);
interface MePayload {
  id: string;
  email: string;
  role: string;
  location_id?: string;
}

app.get("/api/me", (req: Request, res: Response) => {
  const token = extractTokenFromReq(req);
  if (!token) {
    return res.status(401).json({ error: "Nincs token" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as MePayload;

    return res.json({
      id: decoded.id,
      email: decoded.email,
      role: decoded.role,
      location_id: decoded.location_id ?? null,
    });
  } catch (err) {
    console.error("GET /api/me token hiba:", err);
    return res.status(401).json({ error: "Érvénytelen vagy lejárt token" });
  }
});


/* ===== Nem-auth route-ok ===== */
/* ===== Nem-auth route-ok ===== */
/* ===== Nem-auth route-ok ===== */
app.use("/api/menu", menuRoutes);
app.use("/api/menus", menuRoutes);
/*  app.use("/api/me", meRoutes); */
app.use("/api/employees", employeesRouter);
app.use("/api/services/available", servicesAvailableRoutes);
app.use("/api/services", servicesRouter);
app.use("/api/employee-calendar", employeeCalendarRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/locations", locationsRoutes);
app.use("/api/workorders", workorderRoutes);
app.use("/api/bookings", bookingsRoutes);
app.use("/api/transactions", transactionsRoutes);
app.use("/api/schedule/day", scheduleDayRoutes);
app.use("/api/appointments", appointmentsRouter);
 app.use("/api/public", publicMarketingRouter); 
 app.use("/api/services", servicesRouter);
app.use("/api/service-types", serviceTypesRouter);

/* ===== Ügyfelek lista – /api/clients ===== */
app.get("/api/clients", async (req: Request, res: Response) => {
  try {
    const locationId = getLocationIdFromReq(req);

    const params: any[] = [];
    let where = "";
    if (locationId) {
      where = "WHERE c.location_id = $1";
      params.push(locationId);
    }

    const sql = `
      SELECT
        c.id,
        c.location_id,
        c.full_name AS name,
        c.phone,
        c.email
      FROM public.clients c
      ${where}
      ORDER BY c.full_name;
    `;

    const { rows } = await pool.query(sql, params);

    // A frontend a fetchArray<T>()-t használja, ami sima tömböt is tud kezelni
    return res.json(rows);
  } catch (err) {
    console.error("❌ /api/clients hiba:", err);
    return res
      .status(500)
      .json({ error: "Nem sikerült betölteni az ügyfeleket." });
  }
});
/* ===== Foglalási ütközés-ellenőrzés – /api/appointments/conflicts ===== */
app.get("/api/appointments/conflicts", async (req: Request, res: Response) => {
  try {
    const { employee_id, location_id, start, end } = req.query;

    if (!employee_id || !location_id || !start || !end) {
      return res.status(400).json({
        error: "Hiányzó paraméter(ek)",
        details: { employee_id, location_id, start, end },
      });
    }

    const sql = `
      SELECT
        id,
        employee_id,
        location_id,
        client_id,
        start_time,
        end_time,
        status
      FROM public.appointments
      WHERE location_id = $1
        AND employee_id = $2
        AND status IN ('booked','confirmed')
        AND NOT (end_time <= $3::timestamp OR start_time >= $4::timestamp)
      ORDER BY start_time
      LIMIT 50
    `;

    const params = [
      String(location_id),
      String(employee_id),
      String(start),
      String(end),
    ];

    const { rows } = await pool.query(sql, params);

    // Frontendnek elég, ha sima tömb jön vissza
    return res.json(rows);
  } catch (err) {
    console.error("❌ /api/appointments/conflicts hiba:", err);
    return res
      .status(500)
      .json({ error: "Nem sikerült ellenőrizni az ütközéseket." });
  }
});


// 🔹 Publikus marketing endpoint – Szalonjaink oldalnak
app.get("/api/public/salons", async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT
        id,
        name,
        city_label,
        address,
        slug
      FROM public.v_public_salons
      ORDER BY city_label, address
      `
    );

    console.log(">> GET /api/public/salons - rows:", rows.length);
    res.json(rows);
  } catch (err) {
    console.error("GET /api/public/salons error:", err);
    res
      .status(500)
      .json({ error: "Nem sikerült betölteni a szalonokat." });
  }
});

/* ===== Auth route-ok ===== */
app.use("/api", authRoutes);
app.use("/api", authRouter);
app.use("/api", locationsRoutes);
// 404 – EZ MARADJON A ROUTE-OK UTÁN
 app.use((req, res) =>
  res.status(404).json({ error: "Not found", path: req.originalUrl })

);


/* ====== Belépés (1. lépcső) – email VAGY login_name + jelszó ====== */
async function loginHandler(req: Request, res: Response) {
  const { email, login_name, password } =
    (req.body ?? {}) as { email?: string; login_name?: string; password?: string };

  const ident = String(email ?? login_name ?? "").trim().toLowerCase();
  if (!ident || !password) {
    return res
      .status(400)
      .json({ success: false, error: "Hiányzó e-mail/felhasználónév vagy jelszó" });
  }

  try {
    const q = `
      SELECT id, email, login_name, password_hash, role, location_id, active,
             length(password_hash) AS len,
             left(coalesce(password_hash,''), 7) AS head
      FROM users
      WHERE lower(email) = lower($1) OR lower(login_name) = lower($1)
      LIMIT 1
    `;
    const { rows } = await pool.query(q, [ident]);

    if (rows.length === 0) {
      console.warn(`[AUTH] user not found: ${ident}`);
      return res
        .status(401)
        .json({ success: false, error: "Hibás e-mail/felhasználónév vagy jelszó" });
    }

    const user = rows[0];
    if (user.active === false) {
      console.warn(`[AUTH] inactive account: ${ident}`);
      return res.status(403).json({ success: false, error: "Fiók inaktív" });
    }

    const hashType = detectHashType(user.password_hash);
    if (hashType === "bcrypt" && Number(user.len) < 60) {
      console.error(
        `[AUTH] bcrypt hash rövid (truncált?) len=${user.len}, head=${user.head}, ident=${ident}`
      );
    }

    const isMatch = await verifyPassword(user.password_hash, String(password));
    if (!isMatch) {
      console.warn(
        `[AUTH] bad password (type=${hashType}, len=${user.len}, head=${user.head}) ident=${ident}`
      );
      return res
        .status(401)
        .json({ success: false, error: "Hibás e-mail/felhasználónév vagy jelszó" });
    }

    // 6 jegyű kód generálása és ideiglenes tárolása
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresMin = parseInt(process.env.CODE_EXPIRES_MIN ?? "5", 10);
    const emailKey = String(user.email || ident).toLowerCase();

    saveCodeForEmail(emailKey, {
      code,
      userId: user.id,
      role: user.role ?? "guest",
      location_id: user.location_id ?? null,
      expiresAt: Date.now() + expiresMin * 60 * 1000,
    });

    try {
      await sendLoginCodeEmail(emailKey, code);
    } catch (mailErr) {
      console.error("❌ E-mail küldési hiba:", mailErr);
      return res.status(500).json({
        success: false,
        error: "Nem sikerült elküldeni a belépési kódot",
      });
    }

    return res.json({
      success: true,
      step: "code_required",
      message: "Belépési kód elküldve az e-mail címre.",
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
      console.error("verifyCodeHandler login_name lookup hiba:", err);
    }
  }

  // 2) E-mail + kód ellenőrzése
  if (!emailKey || !code) {
    return res
      .status(400)
      .json({ success: false, error: "Hiányzó e-mail vagy kód" });
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
    sameSite: "lax",
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



/* ===== Globális hiba-kezelő ===== */
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("❌ Unhandled error:", err);
  res.status(500).json({ error: "Szerver hiba" });
});

/* ===== Indítás ===== */
const port = Number(process.env.PORT) || 5000;
const host = process.env.HOST || "0.0.0.0";
const server = app.listen(port, host, () =>
  console.log(`✅ Server running on http://${host}:${port}`)
);
server.keepAliveTimeout = 120_000;
server.headersTimeout = 120_000;
server.on("error", (err: NodeJS.ErrnoException) => {
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
