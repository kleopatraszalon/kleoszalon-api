// src/routes/auth.ts
import express from "express";
import pool from "../db";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import nodemailer from "nodemailer";

const authRouter = express.Router();

// ======= SEGÉD: user lekérés email vagy login_name alapján (rugalmas) =======
async function findUserByIdentifier(idOrEmail: string) {
  // 1) e-mail (case-insensitive)
  const r1 = await pool.query(
    `SELECT id, email, role, location_id, password_hash
     FROM users
     WHERE lower(email) = lower($1)
     LIMIT 1`,
    [idOrEmail]
  );
  if (r1.rowCount) return r1.rows[0];

  // 2) login_name (ha van ilyen oszlop)
  try {
    const r2 = await pool.query(
      `SELECT id, email, role, location_id, password_hash
       FROM users
       WHERE lower(login_name) = lower($1)
       LIMIT 1`,
      [idOrEmail]
    );
    if (r2.rowCount) return r2.rows[0];
  } catch {
    // ha nincs login_name oszlop, csendben továbblépünk
  }

  return null;
}

// ======= E-mail küldés beállítása (opcionális) =======
function makeMailer() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_FROM) {
    return null; // nem konfigurált, csak console.log-olni fogunk
  }
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: process.env.SMTP_SECURE === "1", // pl. 465 esetén true
    auth:
      SMTP_USER && SMTP_PASS
        ? { user: SMTP_USER, pass: SMTP_PASS }
        : undefined,
  });
  return { transporter, from: SMTP_FROM };
}

async function sendLoginCodeMail(to: string, code: string) {
  const mailer = makeMailer();
  if (!mailer) {
    console.log(`[LOGIN CODE] ${to}: ${code}`);
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

// ======= 6 jegyű kód generálása =======
function generateCode(): string {
  // 000000–999999 között, vezető nullákkal
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
}

// ======= JWT készítése =======
function signToken(payload: object) {
  const secret = process.env.JWT_SECRET || "dev_secret_change_me";
  return jwt.sign(payload as any, secret, { expiresIn: "8h" });
}

// =====================================================================
// POST /api/login
// - Ellenőrzi a jelszót
// - Generál egy 6 jegyű kódot, eltárolja hash-elve, e-mailben elküldi
// - Válasz: { success: true, step: "code_required" }
// =====================================================================
authRouter.post("/login", async (req, res) => {
  const { email, login_name, password, mode, location_id } = req.body || {};
  const identifier = String(email || login_name || "").trim();

  if (!identifier || typeof password !== "string" || password.length < 1) {
    return res
      .status(400)
      .json({ success: false, error: "Hiányzó felhasználó/jelszó." });
  }

  try {
    const user = await findUserByIdentifier(identifier);
    if (!user) {
      return res.status(401).json({ success: false, error: "Hibás adatok." });
    }

    // Jelszó ellenőrzés
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ success: false, error: "Hibás adatok." });
    }

    // 6 jegyű kód előállítása és eltárolása hash-elve
    const code = generateCode();
    const codeHash = await bcrypt.hash(code, 10);
    const minutes = Number(process.env.LOGIN_CODE_TTL_MIN || 10);

    await pool.query(
      `INSERT INTO login_codes (email, mode, code_hash, expires_at)
       VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval)`,
      [String(user.email || identifier).toLowerCase(), String(mode || "customer"), codeHash, minutes]
    );

    // E-mail kiküldése (vagy log)
    await sendLoginCodeMail(user.email || identifier, code);

    return res.json({
      success: true,
      step: "code_required",
      message: "A belépési kódot elküldtük az e-mail címedre.",
    });
  } catch (err) {
    console.error("LOGIN error:", err);
    return res
      .status(500)
      .json({ success: false, error: "Váratlan hiba történt a bejelentkezéskor." });
  }
});

// =====================================================================
// POST /api/verify-code
// - Ellenőrzi a megadott 6 jegyű kódot (string, vezető nullákkal!)
// - Ha jó és nem járt le, 'used=true' és JWT-t ad vissza
// - Válasz: { success: true, token, role, location_id }
// =====================================================================
authRouter.post("/verify-code", async (req, res) => {
  const { email, login_name, mode, location_id, code } = req.body || {};
  const identifier = String(email || login_name || "").trim().toLowerCase();
  const modeStr = String(mode || "customer");
  const codeStr = String(code || "").trim();

  if (!identifier || !/^\d{6}$/.test(codeStr)) {
    return res
      .status(400)
      .json({ success: false, error: "Hiányzó vagy hibás formátumú kód." });
  }

  try {
    // 1) Keressük a legutóbbi, még fel nem használt kódot
    const r = await pool.query(
      `SELECT id, code_hash, expires_at, used
       FROM login_codes
       WHERE email = $1 AND mode = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [identifier, modeStr]
    );

    if (!r.rowCount) {
      return res.status(401).json({ success: false, error: "Érvénytelen kód." });
    }

    const row = r.rows[0];
    if (row.used) {
      return res
        .status(401)
        .json({ success: false, error: "A kód már felhasználva." });
    }
    if (new Date(row.expires_at) < new Date()) {
      return res.status(401).json({ success: false, error: "A kód lejárt." });
    }

    // 2) Kód ellenőrzés hash-sel
    const match = await bcrypt.compare(codeStr, row.code_hash);
    if (!match) {
      return res.status(401).json({ success: false, error: "Érvénytelen kód." });
    }

    // 3) Kód felhasználtnak jelölése
    await pool.query(`UPDATE login_codes SET used = true WHERE id = $1`, [
      row.id,
    ]);

    // 4) Felhasználó visszakeresése tokenhez (role, location)
    const user = await findUserByIdentifier(identifier);
    if (!user) {
      return res
        .status(401)
        .json({ success: false, error: "Felhasználó nem található." });
    }

    // location_id: ha a kliens küldött customer módban, azt preferáljuk
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

    return res.json({
      success: true,
      token,
      role: user.role || "user",
      location_id: loc ?? null,
    });
  } catch (err) {
    console.error("VERIFY error:", err);
    return res
      .status(500)
      .json({ success: false, error: "Váratlan hiba történt az ellenőrzéskor." });
  }
});

export default authRouter;
