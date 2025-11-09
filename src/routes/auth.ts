// src/routes/auth.ts
import express, { Request, Response } from "express";
import pool from "../db";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import nodemailer from "nodemailer";
import sendLoginCodeEmail from "../mailer";

const authRouter = express.Router();

/* ===================== Beállítások / segédek ===================== */

const DEBUG = process.env.DEBUG_AUTH === "1";
const ALLOW_PLAIN =
  process.env.ALLOW_PLAIN_PASSWORD === "1" || process.env.NODE_ENV !== "production";

/** Csak fejlesztéshez: univerzális "mester" jelszó (pl. DEV_MASTER_PASSWORD=letmein) */
const DEV_MASTER = process.env.DEV_MASTER_PASSWORD || "";

/** Ékezetek lecsupaszítása (példa → pelda) */
function removeDiacritics(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

function log(...args: any[]) {
  if (DEBUG) console.log("[AUTH]", ...args);
}

function signToken(payload: object) {
  const secret = process.env.JWT_SECRET || "dev_secret_change_me";
  return jwt.sign(payload as any, secret, { expiresIn: "8h" });
}

function verifyTokenRaw(token: string) {
  const secret = process.env.JWT_SECRET || "dev_secret_change_me";
  return jwt.verify(token, secret);
}

function extractBearer(req: Request): string | null {
  const h = req.headers["authorization"] || req.headers["Authorization"];
  if (typeof h === "string" && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, "");
  return null;
}

function extractTokenFromReq(req: Request): string | null {
  return (
    extractBearer(req) ||
    (req as any).cookies?.token ||
    (DEBUG ? (req.query?.token as string) : null) ||
    (DEBUG ? (req.body as any)?.token : null) ||
    null
  );
}

/* -------------------- user keresés rugalmasan -------------------- */
async function findUserByIdentifier(anyId: string) {
  const id1 = String(anyId || "").trim().toLowerCase();
  if (!id1) return null;

  // 1) email (case-insensitive)
  const r1 = await pool.query(
    `SELECT id, email, role, location_id, password_hash
     FROM users
     WHERE lower(email) = lower($1)
     LIMIT 1`,
    [id1]
  );
  if (r1.rowCount) return r1.rows[0];

  // 2) login_name (ha van ilyen oszlop)
  try {
    const r2 = await pool.query(
      `SELECT id, email, role, location_id, password_hash
       FROM users
       WHERE lower(login_name) = lower($1)
       LIMIT 1`,
      [id1]
    );
    if (r2.rowCount) return r2.rows[0];
  } catch {
    /* nincs oszlop – lépjünk tovább */
  }

  // 3) ha van ékezet a bemenetben, próbáljuk meg ékezet nélkül
  const id2 = removeDiacritics(id1);
  if (id2 !== id1) {
    const r3 = await pool.query(
      `SELECT id, email, role, location_id, password_hash
       FROM users
       WHERE lower(email) = lower($1)
       LIMIT 1`,
      [id2]
    );
    if (r3.rowCount) return r3.rows[0];

    try {
      const r4 = await pool.query(
        `SELECT id, email, role, location_id, password_hash
         FROM users
         WHERE lower(login_name) = lower($1)
         LIMIT 1`,
        [id2]
      );
      if (r4.rowCount) return r4.rows[0];
    } catch {}
  }

  return null;
}

/** Jelszó ellenőrzés: bcrypt preferált; ha nem bcrypt és ALLOW_PLAIN → plain összehasonlítás.
 * DEV_MASTER megadása esetén (és csak fejlesztéshez ajánlott) bármely felhasználóhoz átengedi.
 */
async function checkPassword(inputPw: string, stored: string | null | undefined): Promise<boolean> {
  const s = stored || "";

  // Dev mesterjelszó
  if (DEV_MASTER && inputPw === DEV_MASTER) {
    log("DEV master password used");
    return true;
  }

  // Bcrypt?
  if (s.startsWith("$2a$") || s.startsWith("$2b$") || s.startsWith("$2y$")) {
    try {
      const ok = await bcrypt.compare(inputPw, s);
      if (DEBUG) log("bcrypt.compare ->", ok);
      return ok;
    } catch (e) {
      if (DEBUG) log("bcrypt error:", e);
      return false;
    }
  }

  // Nem bcrypt: fejlesztésben engedjük a plain-t
  if (ALLOW_PLAIN) {
    const ok = inputPw === s;
    if (DEBUG) log("plain compare ->", ok);
    return ok;
  }

  return false;
}

/* -------------------- Mailer (opcionális) -------------------- */
function makeMailer() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_FROM) return null;
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: process.env.SMTP_SECURE === "1",
    auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });
  return { transporter, from: SMTP_FROM };
}

async function sendLoginCodeMail(to: string, code: string) {
  const mailer = makeMailer();
  if (!mailer) {
    log(`[LOGIN CODE] ${to}: ${code}`);
    return;
  }
  await mailer.transporter.sendMail({
    from: mailer.from,
    to,
    subject: "Belépési kód",
    text: `Az egyszer használatos belépési kódod: ${code}\nA kód 10 percig érvényes.`,
    html: `<p>Az egyszer használatos belépési kódod: <b>${code}</b></p><p>A kód 10 percig érvényes.</p>`,
  });
}

function generateCode(): string {
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
}

/* ===================== POST /api/login ===================== */
authRouter.post("/login", async (req: Request, res: Response) => {
  const { email, login_name, password, mode, location_id } = req.body || {};
  const identifier = String(email || login_name || "").trim().toLowerCase();

  if (!identifier || typeof password !== "string" || password.length < 1) {
    if (DEBUG) res.setHeader("X-Auth-Why", "missing-identifier-or-password");
    return res.status(400).json({ success: false, error: "Hiányzó felhasználó/jelszó." });
  }

  try {
    const user = await findUserByIdentifier(identifier);
    if (!user) {
      if (DEBUG) res.setHeader("X-Auth-Why", "user-not-found");
      return res.status(401).json({ success: false, error: "Hibás adatok." });
    }

    const ok = await checkPassword(String(password), user.password_hash);
    if (!ok) {
      if (DEBUG) res.setHeader("X-Auth-Why", "bad-password");
      return res.status(401).json({ success: false, error: "Hibás adatok." });
    }

    const code = generateCode();
    const codeHash = await bcrypt.hash(code, 10);
    const minutes = Number(process.env.LOGIN_CODE_TTL_MIN || 10);

    await pool.query(
      `INSERT INTO login_codes (email, mode, code_hash, expires_at)
       VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval)`,
      [String(user.email || identifier).toLowerCase(), String(mode || "customer"), codeHash, minutes]
    );

    await sendLoginCodeMail(user.email || identifier, code);

    if (DEBUG) res.setHeader("X-Auth-Why", "ok-code-sent");
    return res.json({
      success: true,
      step: "code_required",
      message: "A belépési kódot elküldtük az e-mail címedre.",
    });
  } catch (err) {
    console.error("LOGIN error:", err);
    if (DEBUG) res.setHeader("X-Auth-Why", "server-error");
    return res.status(500).json({ success: false, error: "Váratlan hiba történt a bejelentkezéskor." });
  }
});

/* ===================== POST /api/verify-code ===================== */
authRouter.post("/verify-code", async (req: Request, res: Response) => {
  const { email, login_name, mode, location_id, code } = req.body || {};
  const identifier = String(email || login_name || "").trim().toLowerCase();
  const modeStr = String(mode || "customer");
  const codeStr = String(code || "").trim();

  if (!identifier || !/^\d{6}$/.test(codeStr)) {
    if (DEBUG) res.setHeader("X-Auth-Why", "bad-identifier-or-code");
    return res.status(400).json({ success: false, error: "Hiányzó vagy hibás formátumú kód." });
  }

  try {
    const r = await pool.query(
      `SELECT id, code_hash, expires_at, used
       FROM login_codes
       WHERE email = $1 AND mode = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [identifier, modeStr]
    );

    if (!r.rowCount) {
      if (DEBUG) res.setHeader("X-Auth-Why", "no-code");
      return res.status(401).json({ success: false, error: "Érvénytelen kód." });
    }

    const row = r.rows[0];
    if (row.used) {
      if (DEBUG) res.setHeader("X-Auth-Why", "already-used");
      return res.status(401).json({ success: false, error: "A kód már felhasználva." });
    }
    if (new Date(row.expires_at) < new Date()) {
      if (DEBUG) res.setHeader("X-Auth-Why", "expired");
      return res.status(401).json({ success: false, error: "A kód lejárt." });
    }

    const match = await bcrypt.compare(codeStr, row.code_hash);
    if (!match) {
      if (DEBUG) res.setHeader("X-Auth-Why", "bad-code");
      return res.status(401).json({ success: false, error: "Érvénytelen kód." });
    }

    await pool.query(`UPDATE login_codes SET used = true WHERE id = $1`, [row.id]);

    const user = await findUserByIdentifier(identifier);
    if (!user) {
      if (DEBUG) res.setHeader("X-Auth-Why", "user-not-found-after-code");
      return res.status(401).json({ success: false, error: "Felhasználó nem található." });
    }

    const loc =
      modeStr === "customer"
        ? (location_id ?? user.location_id ?? null)
        : user.location_id ?? null;

    const token = signToken({
      sub: user.id,
      role: user.role || "user",
      location_id: loc ?? null,
      mode: modeStr,
    });

    res.cookie("token", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: false, // prod-on állítsa true-ra
      path: "/",
      maxAge: 8 * 60 * 60 * 1000,
    });

    if (DEBUG) res.setHeader("X-Auth-Why", "ok-token-issued");
    return res.json({
      success: true,
      token,
      role: user.role || "user",
      location_id: loc ?? null,
    });
  } catch (err) {
    console.error("VERIFY error:", err);
    if (DEBUG) res.setHeader("X-Auth-Why", "server-error");
    return res.status(500).json({ success: false, error: "Váratlan hiba történt az ellenőrzéskor." });
  }
});

/* ===================== Diagnosztika ===================== */

authRouter.get("/auth/token-check", (req: Request, res: Response) => {
  try {
    const tok = extractTokenFromReq(req);
    if (!tok) return res.status(401).json({ ok: false, error: "Hiányzik a token." });
    const decoded = verifyTokenRaw(tok);
    return res.json({ ok: true, decoded });
  } catch (e: any) {
    return res.status(401).json({ ok: false, error: e?.message || "Token hiba" });
  }
});

authRouter.get("/auth/me", (req: Request, res: Response) => {
  try {
    const tok = extractTokenFromReq(req);
    if (!tok) return res.status(401).json({ success: false, error: "Nincs token." });
    const decoded = verifyTokenRaw(tok) as any;
    return res.json({
      success: true,
      user: { id: decoded.sub, role: decoded.role, location_id: decoded.location_id, mode: decoded.mode },
    });
  } catch (e: any) {
    return res.status(401).json({ success: false, error: e?.message || "Érvénytelen token." });
  }
});

export default authRouter;
