"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/auth.ts
const express_1 = __importDefault(require("express"));
const db_1 = __importDefault(require("../db"));
const bcrypt_1 = __importDefault(require("bcrypt"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const crypto_1 = __importDefault(require("crypto"));
const mailer_1 = __importDefault(require("../mailer"));
const tempCodeStore_1 = require("../tempCodeStore");
const authRouter = express_1.default.Router();
/* ===== JWT segédek ===== */
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";
const AUTH_ACCEPT_PLAINTEXT_DEV = process.env.AUTH_ACCEPT_PLAINTEXT_DEV === "1";
function signToken(payload) {
    return jsonwebtoken_1.default.sign(payload, JWT_SECRET, { expiresIn: "8h" });
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
    const s = stored || "";
    try {
        switch (t) {
            case "bcrypt":
                return await bcrypt_1.default.compare(plain, s);
            case "argon2":
                try {
                    // opcionális csomag: npm i argon2
                    // eslint-disable-next-line @typescript-eslint/no-var-requires
                    const argon2 = require("argon2");
                    return await argon2.verify(s, plain);
                }
                catch {
                    console.warn("⚠️ Argon2 hash és 'argon2' csomag nincs telepítve. (npm i argon2)");
                    return false;
                }
            case "pbkdf2": {
                // formátum: pbkdf2$ITER$SALT$HEX
                const parts = s.split("$");
                if (parts.length !== 4)
                    return false;
                const iter = parseInt(parts[1], 10) || 100000;
                const salt = parts[2];
                const hex = parts[3];
                const derived = crypto_1.default
                    .pbkdf2Sync(plain, salt, iter, hex.length / 2, "sha256")
                    .toString("hex");
                return crypto_1.default.timingSafeEqual(Buffer.from(hex, "hex"), Buffer.from(derived, "hex"));
            }
            case "sha256": {
                const hex = s.slice("sha256:".length);
                const digest = crypto_1.default.createHash("sha256").update(plain).digest("hex");
                return crypto_1.default.timingSafeEqual(Buffer.from(hex, "hex"), Buffer.from(digest, "hex"));
            }
            case "plaintext":
                return AUTH_ACCEPT_PLAINTEXT_DEV ? s === plain : false;
            default:
                return AUTH_ACCEPT_PLAINTEXT_DEV ? s === plain : false;
        }
    }
    catch (e) {
        console.error("❌ verifyPassword error:", e);
        return false;
    }
}
/* ====== 1. lépés: /api/login – jelszó ellenőrzés + kód küldés ====== */
authRouter.post("/login", async (req, res) => {
    const { email, login_name, password } = (req.body ?? {});
    const ident = String(email ?? login_name ?? "").trim().toLowerCase();
    if (!ident || !password) {
        return res
            .status(400)
            .json({ success: false, error: "Hiányzó e-mail/felhasználónév vagy jelszó" });
    }
    try {
        const q = `
      SELECT id,
             email,
             password_hash,
             role,
             location_id,
             active,
             length(password_hash) AS len,
             left(coalesce(password_hash, ''), 7) AS head
      FROM users
      WHERE lower(email) = lower($1)
      LIMIT 1
    `;
        const { rows } = await db_1.default.query(q, [ident]);
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
            console.error(`[AUTH] bcrypt hash rövid (truncált?) len=${user.len}, head=${user.head}, ident=${ident}`);
        }
        const isMatch = await verifyPassword(user.password_hash, String(password));
        if (!isMatch) {
            console.warn(`[AUTH] bad password (type=${hashType}, len=${user.len}, head=${user.head}) ident=${ident}`);
            return res
                .status(401)
                .json({ success: false, error: "Hibás e-mail/felhasználónév vagy jelszó" });
        }
        // 🔹 TESZT MÓD: NINCS plusz kód, azonnali belépés
        if (DISABLE_2FA) {
            const token = signToken({
                id: user.id,
                email: user.email,
                role: user.role ?? "guest",
                location_id: user.location_id ?? null,
            });
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
                role: user.role ?? "guest",
                location_id: user.location_id ?? null,
            });
        }
        // 🔹 ÉLES 2FA (ha DISABLE_2FA nincs bekapcsolva) – a régi kód maradhat itt,
        //   vagy akár ki is törölheted, ha biztosan nem kell egyelőre:
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresMin = parseInt(process.env.CODE_EXPIRES_MIN ?? "5", 10);
        const emailKey = String(user.email || ident).toLowerCase();
        console.log(`[AUTH] [LOGIN CODE] ${emailKey}: ${code}`);
        (0, tempCodeStore_1.saveCodeForEmail)(emailKey, {
            code,
            userId: user.id,
            role: user.role ?? "guest",
            location_id: user.location_id ?? null,
            expiresAt: Date.now() + expiresMin * 60 * 1000,
        });
        try {
            await (0, mailer_1.default)(emailKey, code);
        }
        catch (mailErr) {
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
    }
    catch (err) {
        console.error("❌ POST /api/login hiba:", err);
        return res
            .status(500)
            .json({ success: false, error: "Hiba történt a belépés során" });
    }
});
// 🔹 ha ez 1, akkor NINCS kódos 2FA, csak sima login
const DISABLE_2FA = process.env.DISABLE_2FA === "1";
/* ====== 2. lépés: /api/verify-code – kód ellenőrzés + JWT ====== */
authRouter.post("/verify-code", async (req, res) => {
    const { email, login_name, code, location_id, mode } = (req.body ?? {});
    // login_name-t itt is meghagyjuk, de a DB-ben csak emailt nézünk
    let emailKey = String(email ?? login_name ?? "").trim().toLowerCase();
    if (!emailKey || !code) {
        return res
            .status(400)
            .json({ success: false, error: "Hiányzó e-mail vagy kód" });
    }
    // ha nagyon akarjuk, megerősíthetjük, hogy létező user
    try {
        const r = await db_1.default.query(`
      SELECT email
      FROM users
      WHERE lower(email) = $1
      LIMIT 1
    `, [emailKey]);
        if (r.rows.length) {
            emailKey = String(r.rows[0].email || "").toLowerCase();
        }
    }
    catch (err) {
        console.error("verify-code email lookup hiba:", err);
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
    const token = signToken({
        id: record.userId,
        email: emailKey,
        role: record.role,
        location_id: (mode === "customer"
            ? location_id ?? record.location_id
            : record.location_id) ?? null,
    });
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
        location_id: (mode === "customer"
            ? location_id ?? record.location_id
            : record.location_id) ?? null,
    });
});
exports.default = authRouter;
