// src/routes/auth.ts

import express, { Request, Response } from "express";
import db from "../db";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";

/**
 * POST /api/login
 * Body: { email?: string, identifier?: string, username?: string, login?: string, phone?: string, password: string, location_id?: string | null }
 */
router.post("/login", async (req: Request, res: Response) => {
  console.log("[/api/login] body:", req.body);

  const {
    email,
    identifier,
    username,
    login,
    phone,
    password,
    location_id,
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
    console.warn("[/api/login] Hiányzó loginIdentifier vagy password.");
    return res.status(400).json({ error: "Hiányzó azonosító vagy jelszó." });
  }

  try {
    const result = await db.query(
      `
      SELECT *
      FROM users
      WHERE email = $1
      `,
      [loginIdentifier]
    );

    if (result.rowCount === 0) {
      console.warn("[/api/login] Nincs ilyen felhasználó:", loginIdentifier);
      return res.status(401).json({ error: "Hibás felhasználó vagy jelszó." });
    }

    const user: any = result.rows[0];

    const hash: string | undefined = user.password_hash || user.password;

    if (!hash) {
      console.error("[/api/login] Nincs password_hash vagy password mező a users táblában!");
      return res.status(500).json({
        error: "A jelszó mező hiányzik a szerveren. Kérlek jelezd a rendszergazdának.",
      });
    }

    const ok = await bcrypt.compare(password, hash);
    if (!ok) {
      console.warn("[/api/login] Hibás jelszó:", loginIdentifier);
      return res.status(401).json({ error: "Hibás felhasználó vagy jelszó." });
    }

    const effectiveLocationId = location_id ?? user.location_id ?? null;
    const token = jwt.sign(
      {
        id: user.id,
        userId: user.id, // régi kliensek kompatibilitásához
        email: user.email,
        role: user.role,
        location_id: effectiveLocationId,
      },
      JWT_SECRET,
      { expiresIn: "8h" }
    );

    res.cookie("token", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 8 * 60 * 60 * 1000,
    });

    console.log("[/api/login] Sikeres belépés:", loginIdentifier);

    return res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        location_id: effectiveLocationId,
      },
      role: user.role,
      location_id: effectiveLocationId,
      token,
    });
  } catch (err) {
    console.error("[AUTH] /api/login hiba:", err);
    return res
      .status(500)
      .json({ error: "Szerver hiba a bejelentkezés közben." });
  }
});

export default router;
