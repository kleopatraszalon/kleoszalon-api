import express, { Request, Response } from "express";
import pool from "../db";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";

const authRouter = express.Router();

authRouter.post("/login", async (req: Request, res: Response) => {
  const { email, password } = req.body;

  try {
    // 1) user lekérése az adatbázisból
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

    // 2) jelszó ellenőrzés
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: "Hibás belépési adatok" });
    }

    // 3) JWT építése - FIGYELEM: itt rakjuk bele a DB-ből jövő szerepet
    const token = jwt.sign(
      {
        userId: user.id,
        role: user.role,                // <- EZ a kulcs
        location_id: user.location_id,  // <- telephely is mehet a tokenbe
      },
      process.env.JWT_SECRET as string,
      { expiresIn: "12h" }
    );

    // 4) visszaadjuk a frontendre
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
