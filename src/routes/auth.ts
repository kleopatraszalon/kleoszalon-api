// src/routes/auth.ts
import express, { Request, Response } from "express";
import pool from "../db.js";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";

const authRouter = express.Router();

authRouter.post("/login", async (req: Request, res: Response) => {
  const { email, password } = req.body as { email: string; password: string };

  try {
    const result = await pool.query(
      `SELECT id, password_hash, role, location_id
       FROM users
       WHERE email = $1`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Hibás belépési adatok" });
    }

    const user = result.rows[0];

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: "Hibás belépési adatok" });
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      console.error("❌ Hiányzik a JWT_SECRET környezeti változó.");
      return res.status(500).json({ error: "Szerver beállítási hiba (JWT)" });
    }

    const token = jwt.sign(
      {
        userId: user.id,
        role: user.role,
        location_id: user.location_id,
      },
      secret,
      { expiresIn: "12h" }
    );

    return res.json({
      token,
      role: user.role,
      location_id: user.location_id,
    });
  } catch (err) {
    console.error("Login hiba:", err);
    return res.status(500).json({ error: "Szerver hiba bejelentkezéskor" });
  }
});

export default authRouter;
