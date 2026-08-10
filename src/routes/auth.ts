// src/routes/auth.ts

import express, { Request, Response } from "express";
import db from "../db";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import JWT_SECRET from "../security/jwtSecret";

const router = express.Router();

function setAuthCookie(res: Response, token: string) {
  res.cookie("token", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 8 * 60 * 60 * 1000,
  });
}

function roleKeys(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).map(x => x.trim().toLowerCase()).filter(Boolean);
  const value = String(raw ?? "").trim();
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String).map(x => x.trim().toLowerCase()).filter(Boolean);
    if (parsed != null) return [String(parsed).trim().toLowerCase()].filter(Boolean);
  } catch {}
  return value
    .split(",")
    .map(x => x.replace(/[\[\]"]/g, "").trim().toLowerCase())
    .filter(Boolean);
}

function isAdminRole(raw: unknown) {
  return roleKeys(raw).some(r => ["admin", "administrator", "rendszergazda", "superadmin", "super_admin"].includes(r));
}

function isStaffRole(raw: unknown) {
  return roleKeys(raw).some(r => ["employee", "receptionist", "manager", "vezető", "vezeto"].includes(r));
}

async function findUser(identifier: string) {
  try {
    const { rows } = await db.query(
      `SELECT * FROM users
        WHERE lower(COALESCE(email,''))=lower($1)
           OR lower(COALESCE(login_name,''))=lower($1)
        LIMIT 1`,
      [identifier]
    );
    return rows[0] ?? null;
  } catch {
    const { rows } = await db.query(
      `SELECT * FROM users WHERE lower(COALESCE(email,''))=lower($1) LIMIT 1`,
      [identifier]
    );
    return rows[0] ?? null;
  }
}

async function findEmployee(identifier: string, user?: any) {
  const email = String(user?.email || "").trim();
  const loginName = String(user?.login_name || "").trim();
  const { rows } = await db.query(
    `SELECT e.id,e.full_name,e.email,e.login_name,e.password_hash,e.role,e.location_id,
            l.name AS location_name
       FROM employees e
       LEFT JOIN locations l ON l.id=e.location_id
      WHERE COALESCE(e.active,true)=true
        AND (
          lower(COALESCE(e.login_name,''))=lower($1)
          OR lower(COALESCE(e.email,''))=lower($1)
          OR ($2<>'' AND lower(COALESCE(e.email,''))=lower($2))
          OR ($3<>'' AND lower(COALESCE(e.login_name,''))=lower($3))
        )
      ORDER BY CASE WHEN lower(COALESCE(e.login_name,''))=lower($1) THEN 0 ELSE 1 END
      LIMIT 1`,
    [identifier,email,loginName]
  );
  return rows[0] ?? null;
}

async function locationName(locationId: any) {
  if (!locationId) return null;
  try {
    const { rows } = await db.query("SELECT name FROM locations WHERE id=$1 LIMIT 1", [locationId]);
    return rows[0]?.name ?? null;
  } catch {
    return null;
  }
}

async function respondAsEmployee(res: Response, employee: any, password: string, roleOverride?: any) {
  if (!employee.password_hash) {
    return res.status(401).json({ error: "Ehhez a munkatárshoz még nincs jelszó beállítva." });
  }
  const ok = await bcrypt.compare(password, employee.password_hash);
  if (!ok) return res.status(401).json({ error: "Hibás felhasználó vagy jelszó." });
  if (!employee.location_id) {
    return res.status(409).json({ error: "A munkatárshoz nincs telephely rendelve. Kérlek jelezd az adminisztrátornak." });
  }

  const role = roleOverride ?? employee.role ?? ["employee"];
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
    account_type: "staff",
    token,
    role,
    location_id: employee.location_id,
    location_name: employee.location_name ?? null,
    full_name: employee.full_name ?? employee.login_name,
    email: employee.email ?? null,
    employee_id: employee.id,
    login_name: employee.login_name,
  });
}

/**
 * POST /api/login
 * Egységes belépés ügyfeleknek, munkatársaknak és adminisztrátoroknak.
 * A szerepkört és a telephelyet a felhasználói/munkatársi rekord határozza meg,
 * ezért a kliens nem küldhet és nem választhat telephelyet.
 */
router.post("/login", async (req: Request, res: Response) => {
  const { email, identifier, username, login, phone, password } = (req.body || {}) as {
    email?: string;
    identifier?: string;
    username?: string;
    login?: string;
    phone?: string;
    password?: string;
  };

  const loginIdentifier = String(identifier || email || username || login || phone || "").trim();
  if (!loginIdentifier || !password) {
    return res.status(400).json({ error: "Hiányzó azonosító vagy jelszó." });
  }

  try {
    const user = await findUser(loginIdentifier);
    const adminAccount = user && isAdminRole(user.role);
    const employee = adminAccount ? null : await findEmployee(loginIdentifier, user);

    // Munkatárs/recepciós/vezető: az employees rekord az elsődleges,
    // így a saját telephely és employee ID kerül a tokenbe.
    if (employee && (!user || isStaffRole(user.role) || !isAdminRole(user.role))) {
      return respondAsEmployee(res, employee, password, user?.role ?? employee.role);
    }

    if (!user) {
      return res.status(401).json({ error: "Hibás felhasználó vagy jelszó." });
    }

    const hash: string | undefined = user.password_hash || user.password;
    if (!hash) {
      return res.status(500).json({ error: "A felhasználóhoz nincs jelszó beállítva." });
    }

    const ok = await bcrypt.compare(password, hash);
    if (!ok) return res.status(401).json({ error: "Hibás felhasználó vagy jelszó." });

    const effectiveLocationId = user.location_id ?? null;
    const effectiveLocationName = await locationName(effectiveLocationId);
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
      account_type: isAdminRole(user.role) ? "admin" : "customer",
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        location_id: effectiveLocationId,
      },
      role: user.role,
      location_id: effectiveLocationId,
      location_name: effectiveLocationName,
      full_name: user.full_name ?? null,
      email: user.email ?? null,
      login_name: user.login_name ?? null,
      token,
    });
  } catch (err) {
    console.error("[AUTH] /api/login hiba:", err);
    return res.status(500).json({ error: "Szerver hiba a bejelentkezés közben." });
  }
});

/**
 * Visszafelé kompatibilis munkatársi belépési végpont.
 * Az új frontend már az egységes /api/login végpontot használja.
 */
router.post("/employee-login", async (req: Request, res: Response) => {
  const loginName = String(req.body?.login_name || req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  if (!loginName || !password) {
    return res.status(400).json({ error: "Hiányzó felhasználónév vagy jelszó." });
  }

  try {
    const employee = await findEmployee(loginName);
    if (!employee) return res.status(401).json({ error: "Hibás felhasználónév vagy jelszó." });
    return respondAsEmployee(res, employee, password);
  } catch (err) {
    console.error("[AUTH] /api/employee-login hiba:", err);
    return res.status(500).json({ error: "Szerver hiba a munkatársi bejelentkezés közben." });
  }
});

export default router;
