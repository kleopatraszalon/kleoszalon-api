// src/api/auth.ts

import express, { Request, Response } from "express";
import db from "../db";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

const router = express.Router();

async function safePasswordCompare(password: string, hash: string) {
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}

/**
 * Legacy auth router retained for compatibility. The production server mounts
 * src/routes/auth.ts, but this copy must still follow the same security rules.
 */
router.post("/login", async (req: Request, res: Response) => {
  const {
    email,
    identifier,
    username,
    login,
    phone,
    password,
  } = (req.body || {}) as {
    email?: string;
    identifier?: string;
    username?: string;
    login?: string;
    phone?: string;
    password?: string;
    location_id?: string | null;
  };

  const loginIdentifier = (identifier || email || username || login || phone || "").trim();

  if (!loginIdentifier || !password) {
    return res.status(400).json({ error: "Hiányzó azonosító vagy jelszó." });
  }

  try {
    const result = await db.query(
      `SELECT * FROM users WHERE lower(COALESCE(email,''))=lower($1) LIMIT 1`,
      [loginIdentifier]
    );

    if (result.rowCount === 0) {
      return res.status(401).json({ error: "Hibás felhasználó vagy jelszó." });
    }

    const user: any = result.rows[0];
    const hash: string | undefined = user.password_hash || user.password;

    if (!hash) {
      return res.status(401).json({ error: "Hibás felhasználó vagy jelszó." });
    }

    const ok = await safePasswordCompare(password, String(hash));
    if (!ok) {
      return res.status(401).json({ error: "Hibás felhasználó vagy jelszó." });
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      console.error("[AUTH] JWT_SECRET hiányzik; legacy login letiltva.");
      return res.status(503).json({ error: "A bejelentkezési szolgáltatás átmenetileg nem elérhető." });
    }

    const token = jwt.sign(
      { userId: user.id, role: user.role },
      secret,
      { expiresIn: "8h" }
    );

    res.cookie("token", token, {
      httpOnly: true,
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 8 * 60 * 60 * 1000,
    });
    res.setHeader("Cache-Control", "no-store");

    return res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
      },
      token,
    });
  } catch (err) {
    console.error("[AUTH] legacy /api/login hiba:", err);
    return res
      .status(500)
      .json({ error: "Szerver hiba a bejelentkezés közben." });
  }
});

export default router;
