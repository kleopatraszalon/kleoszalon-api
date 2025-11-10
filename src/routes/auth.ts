// src/routes/auth.ts
import express, { Request, Response } from "express";
import pool from "../db";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";

const authRouter = express.Router();

/* ===== JWT segédek ===== */
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";
const AUTH_ACCEPT_PLAINTEXT_DEV = process.env.AUTH_ACCEPT_PLAINTEXT_DEV === "1";

function signToken(payload: object) {
  return jwt.sign(payload as any, JWT_SECRET, { expiresIn: "8h" });
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
        return await bcrypt.compare(plain, s);

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
          Buffer.from(derived, "hex"),
        );
      }

      case "sha256": {
        const hex = s.slice("sha256:".length);
        const digest = crypto.createHash("sha256").update(plain).digest("hex");
        return crypto.timingSafeEqual(
          Buffer.from(hex, "hex"),
          Buffer.from(digest, "hex"),
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

/* ====== EGYSZERŰ LOGIN – NINCS KÓD, NINCS EMAIL ====== */
/**
 * POST /api/login
 * Body: { email?: string; login_name?: string; password: string }
 *
 * Siker esetén:
 *   { success: true, token, role, location_id }
 */
authRouter.post("/login", async (req: Request, res: Response) => {
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
        `[AUTH] bcrypt hash rövid (truncált?) len=${user.len}, head=${user.head}, ident=${ident}`,
      );
    }

    const isMatch = await verifyPassword(user.password_hash, String(password));
    if (!isMatch) {
      console.warn(
        `[AUTH] bad password (type=${hashType}, len=${user.len}, head=${user.head}) ident=${ident}`,
      );
      return res
        .status(401)
        .json({ success: false, error: "Hibás e-mail/felhasználónév vagy jelszó" });
    }

    // 🔹 NINCS PLUSZ KÓD – azonnali token
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
  } catch (err) {
    console.error("❌ POST /api/login hiba:", err);
    return res
      .status(500)
      .json({ success: false, error: "Hiba történt a belépés során" });
  }
});

export default authRouter;
