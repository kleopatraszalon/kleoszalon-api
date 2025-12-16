"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/* ===== .env betöltése AZONNAL ===== */
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const db_1 = __importDefault(require("./db"));
const express_1 = __importDefault(require("express"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const crypto_1 = __importDefault(require("crypto"));
const cors_1 = __importDefault(require("cors"));
const path_1 = __importDefault(require("path"));
/* ===== ROUTES (nem auth) ===== */
const menu_1 = __importDefault(require("./routes/menu"));
/* import meRoutes from "./routes/me"; */
const workorders_1 = __importDefault(require("./routes/workorders"));
const bookings_1 = __importDefault(require("./routes/bookings"));
const transactions_1 = __importDefault(require("./routes/transactions"));
const locations_1 = __importDefault(require("./routes/locations"));
const dashboard_1 = __importDefault(require("./routes/dashboard"));
const employees_1 = __importDefault(require("./routes/employees"));
const services_1 = __importDefault(require("./routes/services"));
const services_available_1 = __importDefault(require("./routes/services_available"));
const employee_calendar_1 = __importDefault(require("./routes/employee_calendar"));
const schedule_day_1 = __importDefault(require("./routes/schedule_day"));
const appointments_1 = __importDefault(require("./routes/appointments"));
const auth_1 = __importDefault(require("./routes/auth")); // auth route-ok
const tempCodeStore_1 = require("./tempCodeStore");
const publicMarketing_1 = __importDefault(require("./routes/publicMarketing"));
const serviceTypes_1 = __importDefault(require("./routes/serviceTypes"));
const products_1 = __importDefault(require("./routes/products"));
const productGroups_1 = __importDefault(require("./routes/productGroups"));
const productCategories_1 = __importDefault(require("./routes/productCategories"));
const publicWebshop_1 = __importDefault(require("./routes/publicWebshop"));
const adminWebshop_1 = __importDefault(require("./routes/adminWebshop"));
const app = (0, express_1.default)();
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
const corsOptions = {
    origin: (origin, cb) => {
        // Postman/curl/server-to-server esetén origin lehet undefined → engedjük
        if (!origin)
            return cb(null, true);
        if (allowedOrigins.includes(origin))
            return cb(null, true);
        return cb(new Error(`CORS blocked for origin: ${origin}`), false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    maxAge: 86400,
};
// CORS MINDIG a route-ok előtt!
app.use((0, cors_1.default)(corsOptions));
// Preflight (OPTIONS) globálisan – így nem lesz 404 és biztosan lesznek CORS headerek
app.options("*", (0, cors_1.default)(corsOptions));
// Vary: Origin – cache korrekt működéséhez
app.use((_, res, next) => {
    res.header("Vary", "Origin");
    next();
});
// JSON + sütik (szintén route-ok előtt)
app.use(express_1.default.json({ limit: "1mb" }));
app.use((0, cookie_parser_1.default)());
/* ===== Statikus feltöltések, hogy a weblap is elérje a képeket ===== */
app.use("/uploads", express_1.default.static(path_1.default.join(__dirname, "..", "uploads")));
// PUBLIC WEBSHOP
app.use("/api/public/webshop", publicWebshop_1.default);
// ADMIN WEBSHOP (ide később érdemes auth middleware-t rakni, pl. verifyAdmin)
app.use("/api/admin/webshop", adminWebshop_1.default);
/* ===== JWT segédek ===== */
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";
const AUTH_ACCEPT_PLAINTEXT_DEV = process.env.AUTH_ACCEPT_PLAINTEXT_DEV === "1";
const DEBUG_AUTH = process.env.DEBUG_AUTH === "1";
function signToken(payload) {
    return jsonwebtoken_1.default.sign(payload, JWT_SECRET, { expiresIn: "8h" });
}
function extractBearer(req) {
    const h = (req.headers["authorization"] ||
        req.headers["Authorization"]);
    return h && /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, "") : null;
}
function extractTokenFromReq(req) {
    return (extractBearer(req) ||
        req.cookies?.token ||
        req.query?.token ||
        req.body?.token ||
        null);
}
function getUserIdFromReq(req) {
    const token = extractTokenFromReq(req);
    if (!token)
        return null;
    try {
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        return decoded.id ?? null;
    }
    catch (err) {
        if (DEBUG_AUTH) {
            console.warn("⚠️ JWT decode error in getUserIdFromReq:", err);
        }
        return null;
    }
}
function getLocationIdFromReq(req) {
    const token = extractTokenFromReq(req);
    if (!token)
        return null;
    try {
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        return decoded.location_id ?? null;
    }
    catch (err) {
        if (DEBUG_AUTH) {
            console.warn("⚠️ JWT decode error in getLocationIdFromReq:", err);
        }
        return null;
    }
}
function detectHashType(hash) {
    if (!hash)
        return "unknown";
    if (hash.startsWith("$2a$") || hash.startsWith("$2b$") || hash.startsWith("$2y$"))
        return "bcrypt";
    if (hash.startsWith("$argon2"))
        return "argon2";
    if (hash.startsWith("pbkdf2$"))
        return "pbkdf2";
    if (hash.startsWith("sha256:"))
        return "sha256";
    if (hash.length > 0 && hash.length < 60)
        return "plaintext";
    return "unknown";
}
async function verifyPassword(stored, plain) {
    const t = detectHashType(stored);
    if (DEBUG_AUTH) {
        console.log("🔐 Hash type:", t, "stored length:", stored?.length);
    }
    if (!stored)
        return false;
    if (t === "bcrypt") {
        return bcryptjs_1.default.compare(plain, stored);
    }
    if (t === "sha256") {
        const [, hashPart] = stored.split(":", 2);
        const hash = crypto_1.default.createHash("sha256").update(plain, "utf8").digest("hex");
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
async function loginHandler(req, res) {
    const { email, login_name, password, location_id } = (req.body ?? {});
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
        const { rows } = await db_1.default.query(`
      SELECT id, email, password_hash, role, location_id, full_name
      FROM users
      WHERE lower(email) = lower($1)
      LIMIT 1
      `, [ident]);
        if (rows.length === 0) {
            console.warn(`[AUTH] user not found: ${ident}`);
            return res
                .status(401)
                .json({ success: false, error: "Érvénytelen felhasználónév/jelszó" });
        }
        const user = rows[0];
        const ok = await verifyPassword(user.password_hash, password);
        if (!ok) {
            console.warn(`[AUTH] bad password for: ${ident}`);
            return res
                .status(401)
                .json({ success: false, error: "Érvénytelen felhasználónév/jelszó" });
        }
        const resolvedLocationId = typeof location_id !== "undefined" && location_id !== null
            ? location_id
            : user.location_id ?? null;
        const payload = {
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
    }
    catch (err) {
        console.error("❌ Login hiba:", err);
        return res
            .status(500)
            .json({ success: false, error: "Hiba történt a belépés során" });
    }
}
/* ====== Kód ellenőrzés (2. lépcső) – JWT ====== */
async function verifyCodeHandler(req, res) {
    const { email, login_name, code, location_id, mode } = (req.body ?? {});
    // 1) E-mail normalizálás
    let emailKey = String(email ?? "").trim().toLowerCase();
    // Ha nincs e-mail, de van login_name (azonosító), megpróbáljuk e-mailre feloldani
    if (!emailKey && login_name) {
        try {
            const ident = String(login_name).trim().toLowerCase();
            const r = await db_1.default.query(`
        SELECT email
        FROM users
        WHERE lower(email) = $1
        LIMIT 1
      `, [ident]);
            if (r.rows.length) {
                emailKey = String(r.rows[0].email || "").toLowerCase();
            }
        }
        catch (err) {
            console.error("❌ verifyCodeHandler - e-mail feloldási hiba:", err);
        }
    }
    if (!emailKey || !code) {
        return res.status(400).json({
            success: false,
            error: "Hiányzó e-mail és/vagy kód",
        });
    }
    const record = (0, tempCodeStore_1.consumeCode)(emailKey);
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
        location_id: (mode === "customer"
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
        location_id: (mode === "customer"
            ? location_id ?? record.location_id
            : record.location_id) ?? null,
    });
}
// FELÜL: itt már legyen importálva a pool
// import pool from "./db";  <-- ezt valószínűleg már használod máshol
/* ===== /api/me – bejelentkezett felhasználó adatai ===== */
app.get("/api/me", async (req, res) => {
    try {
        const token = extractTokenFromReq(req);
        if (!token) {
            return res
                .status(401)
                .json({ success: false, error: "Nincs bejelentkezett felhasználó (hiányzó token)." });
        }
        let decoded;
        try {
            decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        }
        catch (err) {
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
        const { rows } = await db_1.default.query(`
      SELECT id, email, role, full_name, location_id
      FROM users
      WHERE id = $1
      LIMIT 1
      `, [userId]);
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
    }
    catch (err) {
        console.error("❌ /api/me hiba:", err);
        return res
            .status(500)
            .json({ success: false, error: "Hiba történt a felhasználói adatok lekérése közben." });
    }
});
/* ===== API ROUTE-OK REGISZTRÁLÁSA ===== */
// Étlap / menü
app.use("/api/menu", menu_1.default);
app.use("/api/menus", menu_1.default);
// app.use("/api/me", meRoutes);
app.use("/api/workorders", workorders_1.default);
app.use("/api/bookings", bookings_1.default);
app.use("/api/transactions", transactions_1.default);
app.use("/api/locations", locations_1.default);
app.use("/api/dashboard", dashboard_1.default);
app.use("/api/employees", employees_1.default);
app.use("/api/services", services_1.default);
app.use("/api/services-available", services_available_1.default);
app.use("/api/employee-calendar", employee_calendar_1.default);
app.use("/api/schedule/day", schedule_day_1.default);
app.use("/api/appointments", appointments_1.default);
app.use("/api/public", publicMarketing_1.default);
app.use("/api/service-types", serviceTypes_1.default);
// Szalon lista a webshop/marketing oldalhoz
app.get("/api/locations", async (_req, res) => {
    try {
        const result = await db_1.default.query(`
      SELECT
        id,
        name,
        city
      FROM locations
      WHERE is_active = TRUE
      ORDER BY city, name;
      `);
        return res.json({ items: result.rows });
    }
    catch (err) {
        console.error("❌ Szalon lekérési hiba:", err);
        res.status(500).json({ error: "Szalon lekérési hiba" });
    }
});
app.use("/api/products", products_1.default);
app.use("/api/product-groups", productGroups_1.default);
app.use("/api/product-categories", productCategories_1.default);
// Auth saját végpontok (ha a routes/auth mellett is kell):
app.post("/api/auth/login", loginHandler);
app.post("/api/auth/verify-code", verifyCodeHandler);
// Router alapú auth (ha ott vannak további route-ok)
app.use("/api/auth", auth_1.default);
/* ===== Globális hiba-kezelő ===== */
app.use((err, _req, res, _next) => {
    console.error("❌ Unhandled error:", err);
    res.status(500).json({ error: "Szerver hiba" });
});
/* ===== Szerver indítása ===== */
const port = process.env.PORT || 5000;
const server = app.listen(port, () => {
    console.log(`🚀 API szerver fut a(z) ${port} porton`);
});
// Graceful shutdown
server.on("error", (err) => {
    if (err.code === "EADDRINUSE")
        console.error(`❌ Port ${port} már használatban van.`);
    else
        console.error(err);
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
exports.default = app;
