// src/auth.ts
import express, { Request, Response } from "express";
import pool from "./db";
import bcrypt from "bcrypt";
import nodemailer from "nodemailer";
import jwt from "jsonwebtoken";


const authRouter = express.Router();

/* ===========================
   Típusok
=========================== */
type DbUser = {
  id: number;
  email: string;
  role: string | null;
  location_id: number | null;
  password_hash?: string | null;
  password?: string | null; // ha régi oszlopnév maradt
};

type Mailer =
  | { transporter: nodemailer.Transporter; from: string }
  | null;

/* ===========================
   Beállítások
=========================== */
const JWT_SECRET: string =
  process.env.JWT_SECRET || "dev_secret_change_me";

const LOGIN_CODE_TTL_MIN: number = Number(
  process.env.LOGIN_CODE_TTL_MIN || 10
);

const LOGIN_CODE_CHECK_LIMIT: number = Number(
  process.env.LOGIN_CODE_CHECK_LIMIT || 5
);

/* ===========================
   Segédfüggvények
=========================== */
function makeMailer(): Mailer {
  const {
    SMTP_HOST,
    SMTP_PORT,
    SMTP_USER,
    SMTP_PASS,
    SMTP_FROM,
    SMTP_SECURE,
    EMAIL_USER,
    EMAIL_PASS,
  } = process.env;

  // 1) Általános SMTP (ajánlott)
  if (SMTP_HOST && SMTP_PORT && SMTP_FROM) {
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: String(SMTP_SECURE || "0") === "1",
      auth:
        SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    });
    return { transporter, from: SMTP_FROM };
  }

  // 2) Gmail shortcut (ha csak ez van megadva)
  if (EMAIL_USER && EMAIL_PASS) {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: EMAIL_USER, pass: EMAIL_PASS },
    });
    return { transporter, from: `Kleoszalon <${EMAIL_USER}>` };
  }

  // 3) Nincs e-mail: konzolra logolunk
  return null;
}

async function sendLoginCodeMail(to: string, code: string): Promise<void> {
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

function generateCode(): string {
  // 000000–999999 között, vezető nullákkal is
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
}

async function findUserByIdentifier(idOrEmail: string): Promise<DbUser | null> {
  const ident = String(idOrEmail || "").trim();
  if (!ident) return null;

  // 1) email (case-insensitive)
  const r1 = await pool.query(
    `SELECT id, email, role, location_id, password_hash, password
     FROM users
     WHERE lower(email) = lower($1)
     LIMIT 1`,
    [ident]
  );
  if (r1.rowCount) return r1.rows[0] as DbUser;

  // 2) login_name (ha van ilyen oszlop)
  try {
    const r2 = await pool.query(
      `SELECT id, email, role, location_id, password_hash, password
       FROM users
       WHERE lower(login_name) = lower($1)
       LIMIT 1`,
      [ident]
    );
    if (r2.rowCount) return r2.rows[0] as DbUser;
  } catch {
    // ha nincs login_name oszlop, csendben átugorjuk
  }
  return null;
}

async function checkPassword(user: DbUser | null, plain: string): Promise<boolean> {
  const hash: string | undefined | null =
    (user && user.password_hash) || (user && user.password);
  if (!hash || typeof plain !== "string") return false;
  try {
    return await bcrypt.compare(plain, String(hash));
  } catch {
    return false;
  }
}

function signToken(payload: Record<string, unknown>): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "8h" });
}

/* ===========================
   Végpontok
=========================== */

// (opcionális) egészség-ellenőrzés: végső URL /api/health ha app.use("/api", authRouter)
authRouter.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// 1) /api/login  ← mount: app.use("/api", authRouter)
authRouter.post("/login", async (req: Request, res: Response) => {
  const { email, login_name, password, mode, location_id } = req.body || {};
  const identifier: string = String(email || login_name || "").trim();

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
    const codeHash = await bcrypt.hash(code, 10);

    await pool.query(
      `INSERT INTO login_codes (email, mode, code_hash, expires_at)
       VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval)`,
      [
        String(user.email || identifier).toLowerCase(),
        String(mode || "customer"),
        codeHash,
        LOGIN_CODE_TTL_MIN,
      ]
    );

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

// 2) /api/verify-code  ← mount: app.use("/api", authRouter)
authRouter.post("/verify-code", async (req: Request, res: Response) => {
  const { email, login_name, mode, location_id, code } = req.body || {};
  const rawIdentifier: string = String(email || login_name || "").trim();
  const modeStr: string = String(mode || "customer");
  const codeStr: string = String(code || "").trim();

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
    let r = await pool.query(
      `SELECT id, code_hash, expires_at, used
       FROM login_codes
       WHERE email = $1 AND mode = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [canonicalEmail, modeStr, LOGIN_CODE_CHECK_LIMIT]
    );

    if (!r.rowCount) {
      r = await pool.query(
        `SELECT id, code_hash, expires_at, used
         FROM login_codes
         WHERE email = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [canonicalEmail, LOGIN_CODE_CHECK_LIMIT]
      );
      if (!r.rowCount) {
        return res
          .status(401)
          .json({ success: false, error: "Érvénytelen kód." });
      }
    }

    // élő, fel nem használt kódok között keresünk egyezést
    const now = Date.now();
    let matchedId: number | null = null;

    for (const row of r.rows as Array<{
      id: number;
      code_hash: string;
      expires_at: string | Date;
      used: boolean;
    }>) {
      if (row.used) continue;
      if (new Date(row.expires_at).getTime() < now) continue;
      const ok = await bcrypt.compare(codeStr, row.code_hash);
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
    await pool.query(`UPDATE login_codes SET used = true WHERE id = $1`, [
      matchedId,
    ]);

    // token kiadása
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
