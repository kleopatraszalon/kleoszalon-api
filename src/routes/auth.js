// src/routes/auth.ts
import express, { Request, Response } from "express";
import pool from "../db";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import nodemailer from "nodemailer";

const authRouter = express.Router();

/* =================== Helpers =================== */

const DEBUG = process.env.DEBUG_AUTH === "1";
const BCRYPT_RE = /^\$2[aby]\$/;

function isBcryptHash(x: unknown): x is string {
  return typeof x === "string" && BCRYPT_RE.test(x);
}

async function checkPassword(raw: string, stored: unknown): Promise<boolean> {
  const s = String(stored ?? "");
  if (isBcryptHash(s)) return bcrypt.compare(String(raw), s);
  if (process.env.ALLOW_PLAIN_PASSWORD === "1") return String(raw) === s;
  return false;
}

/** Email/login_name → user + jelszó **több oszlopból** (password_hash, password, pwd) */
async function findUserByIdentifier(idOrEmail: string) {
  const ident = String(idOrEmail || "").trim();

  // 1) modern: password_hash (bcrypt)
  const q1 = `
    SELECT id, email, role, location_id, password_hash
    FROM users
    WHERE lower(email) = lower($1)
    LIMIT 1`;
  const r1 = await pool.query(q1, [ident]);
  if (r1.rowCount) return r1.rows[0];

  const q1b = `
    SELECT id, email, role, location_id, password_hash
    FROM users
    WHERE lower(login_name) = lower($1)
    LIMIT 1`;
  try {
    const r1b = await pool.query(q1b, [ident]);
    if (r1b.rowCount) return r1b.rows[0];
  } catch {}

  // 2) legacy: password → map-peljük password_hash névre
  try {
    const q2 = `
      SELECT id, email, role, location_id, password AS password_hash
      FROM users
      WHERE lower(email) = lower($1)
      LIMIT 1`;
    const r2 = await pool.query(q2, [ident]);
    if (r2.rowCount) return r2.rows[0];
  } catch {}

  try {
    const q2b = `
      SELECT id, email, role, location_id, password AS password_hash
      FROM users
      WHERE lower(login_name) = lower($1)
      LIMIT 1`;
    const r2b = await pool.query(q2b, [ident]);
    if (r2b.rowCount) return r2b.rows[0];
  } catch {}

  // 3) más név: pwd → map password_hash-ra
  try {
    const q3 = `
      SELECT id, email, role, location_id, pwd AS password_hash
      FROM users
      WHERE lower(email) = lower($1)
      LIMIT 1`;
    const r3 = await pool.query(q3, [ident]);
    if (r3.rowCount) return r3.rows[0];
  } catch {}

  try {
    const q3b = `
      SELECT id, email, role, location_id, pwd AS password_hash
      FROM users
      WHERE lower(login_name) = lower($1)
      LIMIT 1`;
    const r3b = await pool.query(q3b, [ident]);
    if (r3b.rowCount) return r3b.rows[0];
  } catch {}

  return null;
}

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
  if (!mailer) { console.log(`[LOGIN CODE] ${to}: ${code}`); return; }
  await mailer.transporter.sendMail({
    from: mailer.from, to,
    subject: "Belépési kód",
    text: `Kód: ${code} (10 percig érvényes)`,
    html: `Kód: <b>${code}</b> (10 percig érvényes)`,
  });
}

function generateCode(): string {
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
}

function signToken(payload: object) {
  const secret = process.env.JWT_SECRET || "dev_secret_change_me";
  return jwt.sign(payload as any, secret, { expiresIn: "8h" });
}

async function ensureLoginCodesTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS login_codes (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      mode TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      used BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS login_codes_email_mode_created_idx
      ON login_codes(email, mode, created_at DESC);
  `);
}

/* =================== Handlers =================== */

async function loginHandler(req: Request, res: Response) {
  const { email, login_name, password, mode } = req.body || {};
  const identifier = String(email || login_name || "").trim();

  if (!identifier || typeof password !== "string" || password.length < 1) {
    return res.status(400).json({ success: false, error: "Hiányzó felhasználó/jelszó." });
  }

  try {
    const user = await findUserByIdentifier(identifier);
    if (!user) {
      if (DEBUG) console.debug("AUTH login: user not found:", identifier);
      return res.status(401).json({ success: false, error: "Hibás adatok." });
    }

    const ok = await checkPassword(password, user.password_hash);
    if (!ok) {
      if (DEBUG) {
        console.debug("AUTH login: password mismatch", {
          identifier,
          haveHash: Boolean(user.password_hash),
          looksBcrypt: isBcryptHash(user.password_hash),
          allowPlain: process.env.ALLOW_PLAIN_PASSWORD === "1",
        });
      }
      return res.status(401).json({ success: false, error: "Hibás adatok." });
    }

    await ensureLoginCodesTable();

    const code = generateCode();
    const codeHash = await bcrypt.hash(code, 10);
    const minutes = Number(process.env.LOGIN_CODE_TTL_MIN || 10);

    await pool.query(
      `INSERT INTO login_codes (email, mode, code_hash, expires_at)
       VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval)`,
      [String(user.email || identifier).toLowerCase(), String(mode || "customer"), codeHash, minutes]
    );

    await sendLoginCodeMail(user.email || identifier, code);

    return res.json({
      success: true,
      step: "code_required",
      message: "A belépési kódot elküldtük az e-mail címedre.",
    });
  } catch (err) {
    console.error("LOGIN error:", err);
    return res.status(500).json({ success: false, error: "Váratlan hiba történt." });
  }
}

async function verifyCodeHandler(req: Request, res: Response) {
  const { email, login_name, mode, location_id, code } = req.body || {};
  const identifier = String(email || login_name || "").trim().toLowerCase();
  const modeStr = String(mode || "customer");
  const codeStr = String(code || "").trim();

  if (!identifier || !/^\d{6}$/.test(codeStr)) {
    return res.status(400).json({ success: false, error: "Hiányzó vagy hibás kód." });
  }

  try {
    await ensureLoginCodesTable();

    const r = await pool.query(
      `SELECT id, code_hash, expires_at, used
       FROM login_codes
       WHERE email = $1 AND mode = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [identifier, modeStr]
    );
    if (!r.rowCount) return res.status(401).json({ success: false, error: "Érvénytelen kód." });

    const row = r.rows[0];
    if (row.used)   return res.status(401).json({ success: false, error: "A kód már felhasználva." });
    if (new Date(row.expires_at) < new Date())
      return res.status(401).json({ success: false, error: "A kód lejárt." });

    const match = await bcrypt.compare(codeStr, row.code_hash);
    if (!match) return res.status(401).json({ success: false, error: "Érvénytelen kód." });

    await pool.query(`UPDATE login_codes SET used = true WHERE id = $1`, [row.id]);

    const user = await findUserByIdentifier(identifier);
    if (!user) return res.status(401).json({ success: false, error: "Felhasználó nem található." });

    const loc = modeStr === "customer"
      ? (location_id ?? user.location_id ?? null)
      : user.location_id ?? null;

    const token = signToken({ sub: user.id, role: user.role || "user", location_id: loc ?? null, mode: modeStr });

    return res.json({ success: true, token, role: user.role || "user", location_id: loc ?? null });
  } catch (err) {
    console.error("VERIFY error:", err);
    return res.status(500).json({ success: false, error: "Váratlan hiba történt." });
  }
}

/* =================== Routes (dupla prefix támogatás) =================== */
authRouter.post("/login", loginHandler);
authRouter.post("/verify-code", verifyCodeHandler);
authRouter.post("/auth/login", loginHandler);
authRouter.post("/auth/verify-code", verifyCodeHandler);

export default authRouter;
