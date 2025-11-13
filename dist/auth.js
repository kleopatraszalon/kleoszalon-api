"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/auth.ts
const express_1 = __importDefault(require("express"));
const db_1 = __importDefault(require("./db"));
const bcrypt_1 = __importDefault(require("bcrypt"));
const nodemailer_1 = __importDefault(require("nodemailer"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const authRouter = express_1.default.Router();
/* ===========================
   Beállítások
=========================== */
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";
const LOGIN_CODE_TTL_MIN = Number(process.env.LOGIN_CODE_TTL_MIN || 10);
const LOGIN_CODE_CHECK_LIMIT = Number(process.env.LOGIN_CODE_CHECK_LIMIT || 5);
/* ===========================
   Segédfüggvények
=========================== */
function makeMailer() {
    const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_SECURE, EMAIL_USER, EMAIL_PASS, } = process.env;
    // 1) Általános SMTP (ajánlott)
    if (SMTP_HOST && SMTP_PORT && SMTP_FROM) {
        const transporter = nodemailer_1.default.createTransport({
            host: SMTP_HOST,
            port: Number(SMTP_PORT),
            secure: String(SMTP_SECURE || "0") === "1",
            auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
        });
        return { transporter, from: SMTP_FROM };
    }
    // 2) Gmail shortcut (ha csak ez van megadva)
    if (EMAIL_USER && EMAIL_PASS) {
        const transporter = nodemailer_1.default.createTransport({
            service: "gmail",
            auth: { user: EMAIL_USER, pass: EMAIL_PASS },
        });
        return { transporter, from: `Kleoszalon <${EMAIL_USER}>` };
    }
    // 3) Nincs e-mail: konzolra logolunk
    return null;
}
async function sendLoginCodeMail(to, code) {
    const mailer = makeMailer();
    if (!mailer) {
        console.log(`[LOGIN CODE] to=${to} code=${code}`);
        return;
    }
    await mailer.transporter.sendMail({
        from: mailer.from,
        to,
        subject: "Kleoszalon belépési kód",
        text: `Az egyszer használatos belépési kódod: ${code}\nA kód ${LOGIN_CODE_TTL_MIN} percig érvényes.`,
        html: `<p>Az egyszer használatos belépési kódod: <b>${code}</b></p><p>A kód ${LOGIN_CODE_TTL_MIN} percig érvényes.</p>`,
    });
}
function generateCode() {
    // 000000–999999 között, vezető nullákkal is
    return String(Math.floor(Math.random() * 1000000)).padStart(6, "0");
}
async function findUserByIdentifier(idOrEmail) {
    const ident = String(idOrEmail || "").trim();
    if (!ident)
        return null;
    // 1) email (case-insensitive)
    const r1 = await db_1.default.query(`SELECT id, email, role, location_id, password_hash, password
     FROM users
     WHERE lower(email) = lower($1)
     LIMIT 1`, [ident]);
    if (r1.rowCount)
        return r1.rows[0];
    // 2) login_name (ha van ilyen oszlop)
    try {
        const r2 = await db_1.default.query(`SELECT id, email, role, location_id, password_hash, password
       FROM users
       WHERE lower(login_name) = lower($1)
       LIMIT 1`, [ident]);
        if (r2.rowCount)
            return r2.rows[0];
    }
    catch {
        // ha nincs login_name oszlop, csendben átugorjuk
    }
    return null;
}
async function checkPassword(user, plain) {
    const hash = (user && user.password_hash) || (user && user.password);
    if (!hash || typeof plain !== "string")
        return false;
    try {
        return await bcrypt_1.default.compare(plain, String(hash));
    }
    catch {
        return false;
    }
}
function signToken(payload) {
    return jsonwebtoken_1.default.sign(payload, JWT_SECRET, { expiresIn: "8h" });
}
/* ===========================
   Végpontok
=========================== */
// (opcionális) egészség-ellenőrzés: végső URL /api/health ha app.use("/api", authRouter)
authRouter.get("/health", (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
});
// 1) /api/login  ← mount: app.use("/api", authRouter)
authRouter.post("/login", async (req, res) => {
    const { email, login_name, password, mode, location_id } = req.body || {};
    const identifier = String(email || login_name || "").trim();
    if (!identifier || !password) {
        return res
            .status(400)
            .json({ success: false, error: "Hiányzó felhasználó/jelszó." });
    }
    try {
        const user = await findUserByIdentifier(identifier);
        if (!user) {
            return res.status(401).json({ success: false, error: "Hibás adatok." });
        }
        const ok = await checkPassword(user, String(password));
        if (!ok) {
            return res.status(401).json({ success: false, error: "Hibás adatok." });
        }
        // kód generálása + hash
        const code = generateCode();
        const codeHash = await bcrypt_1.default.hash(code, 10);
        await db_1.default.query(`INSERT INTO login_codes (email, mode, code_hash, expires_at)
       VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval)`, [
            String(user.email || identifier).toLowerCase(),
            String(mode || "customer"),
            codeHash,
            LOGIN_CODE_TTL_MIN,
        ]);
        await sendLoginCodeMail(user.email || identifier, code);
        return res.json({
            success: true,
            step: "code_required",
            message: "A belépési kódot elküldtük az e-mail címedre.",
        });
    }
    catch (err) {
        console.error("LOGIN error:", err);
        return res
            .status(500)
            .json({ success: false, error: "Váratlan hiba történt a bejelentkezéskor." });
    }
});
// 2) /api/verify-code  ← mount: app.use("/api", authRouter)
authRouter.post("/verify-code", async (req, res) => {
    const { email, login_name, mode, location_id, code } = req.body || {};
    const rawIdentifier = String(email || login_name || "").trim();
    const modeStr = String(mode || "customer");
    const codeStr = String(code || "").trim();
    if (!rawIdentifier || !/^\d{6}$/.test(codeStr)) {
        return res
            .status(400)
            .json({ success: false, error: "Hiányzó vagy hibás formátumú kód." });
    }
    try {
        // user beazonosítása → kanonikus e-mail
        const user = await findUserByIdentifier(rawIdentifier);
        if (!user || !user.email) {
            return res
                .status(401)
                .json({ success: false, error: "Felhasználó nem található." });
        }
        const canonicalEmail = String(user.email).toLowerCase();
        // utolsó néhány kód beolvasása (először adott módra, majd fallback)
        let r = await db_1.default.query(`SELECT id, code_hash, expires_at, used
       FROM login_codes
       WHERE email = $1 AND mode = $2
       ORDER BY created_at DESC
       LIMIT $3`, [canonicalEmail, modeStr, LOGIN_CODE_CHECK_LIMIT]);
        if (!r.rowCount) {
            r = await db_1.default.query(`SELECT id, code_hash, expires_at, used
         FROM login_codes
         WHERE email = $1
         ORDER BY created_at DESC
         LIMIT $2`, [canonicalEmail, LOGIN_CODE_CHECK_LIMIT]);
            if (!r.rowCount) {
                return res
                    .status(401)
                    .json({ success: false, error: "Érvénytelen kód." });
            }
        }
        // élő, fel nem használt kódok között keresünk egyezést
        const now = Date.now();
        let matchedId = null;
        for (const row of r.rows) {
            if (row.used)
                continue;
            if (new Date(row.expires_at).getTime() < now)
                continue;
            const ok = await bcrypt_1.default.compare(codeStr, row.code_hash);
            if (ok) {
                matchedId = row.id;
                break;
            }
        }
        if (!matchedId) {
            return res
                .status(401)
                .json({ success: false, error: "Érvénytelen vagy lejárt kód." });
        }
        // matched kód felhasználtnak jelölése
        await db_1.default.query(`UPDATE login_codes SET used = true WHERE id = $1`, [
            matchedId,
        ]);
        // token kiadása
        const loc = modeStr === "customer"
            ? (location_id ?? user.location_id ?? null)
            : user.location_id ?? null;
        const token = signToken({
            sub: user.id,
            role: user.role || "user",
            location_id: loc ?? null,
            mode: modeStr,
        });
        return res.json({
            success: true,
            token,
            role: user.role || "user",
            location_id: loc ?? null,
        });
    }
    catch (err) {
        console.error("VERIFY error:", err);
        return res
            .status(500)
            .json({ success: false, error: "Váratlan hiba történt az ellenőrzéskor." });
    }
});
exports.default = authRouter;
