import express from "express";
import pool from "./db";
import bcrypt from "bcrypt";
import crypto from "crypto";
import nodemailer from "nodemailer";
import jwt from "jsonwebtoken";

const router = express.Router();

// 💌 Email küldő beállítás (Gmail vagy SMTP)
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// 🧩 1️⃣ Első lépés: email + jelszó ellenőrzés, kód generálás
router.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const userResult = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    if (userResult.rows.length === 0)
      return res.status(401).json({ error: "Nincs ilyen felhasználó" });

    const user = userResult.rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: "Hibás jelszó" });

    // 🔐 6 számjegyű kód
    const code = crypto.randomInt(100000, 999999).toString();

    // ideiglenesen mentjük az adatbázisba
    await pool.query("UPDATE users SET login_code = $1 WHERE email = $2", [code, email]);

    // 📩 e-mail küldése
    await transporter.sendMail({
      from: `"Kleoszalon" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: "Kleoszalon belépési kód",
      text: `Az Ön belépési kódja: ${code}\n\nA kód 5 percig érvényes.`,
    });

    res.json({ message: "Hitelesítési kód elküldve az e-mail címre" });
  } catch (err) {
    console.error("Login hiba:", err);
    res.status(500).json({ error: "Szerver hiba" });
  }
});

// 🧠 2️⃣ Második lépés: kód ellenőrzése
router.post("/api/verify-code", async (req, res) => {
  const { email, code } = req.body;
  try {
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Felhasználó nem található" });

    const user = result.rows[0];
    if (user.login_code !== code)
      return res.status(401).json({ error: "Érvénytelen kód" });

    // ✅ Token generálás
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET!,
      { expiresIn: "1h" }
    );

    // töröljük a kódot
    await pool.query("UPDATE users SET login_code = NULL WHERE email = $1", [email]);

    res.json({ message: "Sikeres hitelesítés", token });
  } catch (err) {
    console.error("Verify code hiba:", err);
    res.status(500).json({ error: "Szerver hiba" });
  }
});

export default router;
