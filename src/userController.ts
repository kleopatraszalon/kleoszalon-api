// src/users.ts (vagy ahogy nálad hívják ezt a routert)
import "dotenv/config";
import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pool from "./db.js";

const router = Router();

/** Új felhasználó létrehozása */
router.post("/create", async (req: Request, res: Response) => {
  try {
    const { full_name, email, password, role } = req.body as {
      full_name?: string;
      email?: string;
      password?: string;
      role?: string;
    };

    if (!full_name || !email || !password || !role) {
      return res.status(400).json({ error: "Hiányzó mezők" });
    }

    // (opcionális) e-mail egyediség ellenőrzés
    const exists = await pool.query("SELECT 1 FROM users WHERE email = $1", [email]);
    if (exists.rowCount && exists.rowCount > 0) {
      return res.status(409).json({ error: "Ezzel az e-maillel már létezik felhasználó" });
    }

    const password_hash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (full_name, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, full_name, email, role`,
      [full_name, email, password_hash, role]
    );

    return res.status(201).json({ message: "Felhasználó létrehozva", user: result.rows[0] });
  } catch (err: unknown) {
    // Postgres egyedi kulcs sértés: 23505
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "23505"
    ) {
      return res.status(409).json({ error: "Duplikált adat (valószínűleg e-mail)" });
    }

    console.error("Hiba a felhasználó mentésekor:", err);
    return res.status(500).json({ error: "Adatbázis hiba" });
  }
});

/** Verify code endpoint – DEMÓ: mindig 123456 */
router.post("/verify-code", async (req: Request, res: Response) => {
  try {
    const { email, code } = req.body as { email?: string; code?: string };

    if (!email || !code) {
      return res.status(400).json({ error: "Hiányzó mezők" });
    }

    if (code !== "123456") {
      return res.status(400).json({ error: "Érvénytelen kód" });
    }

    const userResult = await pool.query(
      "SELECT id, email, role FROM users WHERE email = $1",
      [email]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "Felhasználó nem található" });
    }

    const user = userResult.rows[0];

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      console.error("Hiányzó JWT_SECRET környezeti változó.");
      return res.status(500).json({ error: "Szerver beállítási hiba (JWT)" });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      secret,
      { expiresIn: "1h" }
    );

    return res.json({ message: "Sikeres hitelesítés", token });
  } catch (err) {
    console.error("Hiba a kód ellenőrzésekor:", err);
    return res.status(500).json({ error: "Szerver hiba" });
  }
});

export default router;
