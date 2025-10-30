import { Router, Request, Response } from "express";
import  pool from "./db";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const router = Router();

// 🔹 Új felhasználó létrehozása
router.post("/create", async (req: Request, res: Response) => {
  try {
    const { full_name, email, password, role } = req.body;

    if (!full_name || !email || !password || !role) {
      return res.status(400).json({ error: "Hiányzó mezők" });
    }

    const password_hash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (full_name, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, full_name, email, role`,
      [full_name, email, password_hash, role]
    );

    res.status(201).json({ message: "Felhasználó létrehozva", user: result.rows[0] });
  } catch (err: any) {
    console.error("Hiba a felhasználó mentésekor:", err);
    res.status(500).json({ error: "Adatbázis hiba" });
  }
});

// 🔹 Verify code endpoint – mindig 123456
router.post("/verify-code", async (req: Request, res: Response) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ error: "Hiányzó mezők" });
    }

    // Teszt: kód mindig 123456
    if (code !== "123456") {
      return res.status(400).json({ error: "Érvénytelen kód" });
    }

    // Felhasználó lekérése az adatbázisból
    const userResult = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "Felhasználó nem található" });
    }

    const user = userResult.rows[0];

    // Token generálás
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET as string,
      { expiresIn: "1h" }
    );

    // Mindig JSON-t küldünk vissza
    res.json({ message: "Sikeres hitelesítés", token });
  } catch (err: any) {
    console.error("Hiba a kód ellenőrzésekor:", err);
    res.status(500).json({ error: "Szerver hiba" });
  }
});

export default router;
