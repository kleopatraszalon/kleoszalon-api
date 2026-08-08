// src/routes/auth.ts

import express, { Request, Response } from "express";
import db from "../db";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";

function setAuthCookie(res: Response, token: string) {
  res.cookie("token", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 8 * 60 * 60 * 1000,
  });
}

/**
 * POST /api/login
 * Ügyfél/admin belépés. A telephely ezen a belépési ágon továbbra is választható.
 */
router.post("/login", async (req: Request, res: Response) => {
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

  const loginIdentifier = String(identifier || email || username || login || phone || "").trim();
  if (!loginIdentifier || !password) {
    return res.status(400).json({ error: "Hiányzó azonosító vagy jelszó." });
  }

  try {
    let result;
    try {
      result = await db.query(
        `SELECT * FROM users
          WHERE lower(COALESCE(email,''))=lower($1)
             OR lower(COALESCE(login_name,''))=lower($1)
          LIMIT 1`,
        [loginIdentifier]
      );
    } catch {
      result = await db.query(
        `SELECT * FROM users WHERE lower(COALESCE(email,''))=lower($1) LIMIT 1`,
        [loginIdentifier]
      );
    }

    if (result.rowCount === 0) {
      return res.status(401).json({ error: "Hibás felhasználó vagy jelszó." });
    }

    const user: any = result.rows[0];
    const hash: string | undefined = user.password_hash || user.password;
    if (!hash) {
      return res.status(500).json({ error: "A felhasználóhoz nincs jelszó beállítva." });
    }

    const ok = await bcrypt.compare(password, hash);
    if (!ok) return res.status(401).json({ error: "Hibás felhasználó vagy jelszó." });

    const effectiveLocationId = location_id ?? user.location_id ?? null;
    const token = jwt.sign(
      {
        id: user.id,
        userId: user.id,
        email: user.email,
        role: user.role,
        location_id: effectiveLocationId,
      },
      JWT_SECRET,
      { expiresIn: "8h" }
    );

    setAuthCookie(res, token);
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
      full_name: user.full_name ?? null,
      token,
    });
  } catch (err) {
    console.error("[AUTH] /api/login hiba:", err);
    return res.status(500).json({ error: "Szerver hiba a bejelentkezés közben." });
  }
});

/**
 * POST /api/employee-login
 * Munkatársi belépés employees.login_name + password_hash alapján.
 * A telephely NEM választható: mindig a munkatárshoz rögzített employees.location_id érvényes.
 */
router.post("/employee-login", async (req: Request, res: Response) => {
  const loginName = String(req.body?.login_name || req.body?.username || "").trim();
  const password = String(req.body?.password || "");

  if (!loginName || !password) {
    return res.status(400).json({ error: "Hiányzó felhasználónév vagy jelszó." });
  }

  try {
    const result = await db.query(
      `SELECT e.id,e.full_name,e.email,e.login_name,e.password_hash,e.role,e.location_id,
              l.name AS location_name
         FROM employees e
         LEFT JOIN locations l ON l.id=e.location_id
        WHERE lower(COALESCE(e.login_name,''))=lower($1)
          AND COALESCE(e.active,true)=true
        LIMIT 1`,
      [loginName]
    );

    if (!result.rowCount) {
      return res.status(401).json({ error: "Hibás felhasználónév vagy jelszó." });
    }

    const employee: any = result.rows[0];
    if (!employee.password_hash) {
      return res.status(401).json({ error: "Ehhez a munkatárshoz még nincs jelszó beállítva." });
    }

    const ok = await bcrypt.compare(password, employee.password_hash);
    if (!ok) {
      return res.status(401).json({ error: "Hibás felhasználónév vagy jelszó." });
    }

    if (!employee.location_id) {
      return res.status(409).json({ error: "A munkatárshoz nincs telephely rendelve. Kérlek jelezd az adminisztrátornak." });
    }

    const role = employee.role ?? ["employee"];
    const token = jwt.sign(
      {
        id: employee.id,
        userId: employee.id,
        employee_id: employee.id,
        email: employee.email || employee.login_name,
        login_name: employee.login_name,
        role,
        location_id: employee.location_id,
      },
      JWT_SECRET,
      { expiresIn: "8h" }
    );

    setAuthCookie(res, token);
    return res.json({
      success: true,
      token,
      role,
      location_id: employee.location_id,
      location_name: employee.location_name ?? null,
      full_name: employee.full_name ?? employee.login_name,
      employee_id: employee.id,
      login_name: employee.login_name,
    });
  } catch (err) {
    console.error("[AUTH] /api/employee-login hiba:", err);
    return res.status(500).json({ error: "Szerver hiba a munkatársi bejelentkezés közben." });
  }
});

export default router;
