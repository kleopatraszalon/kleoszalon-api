// src/routes/bookings.ts
import express, { Response } from "express";
import pool from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = express.Router();
router.use(requireAuth);

const ADMIN = new Set(["admin","administrator","rendszergazda","superadmin","super_admin"]);
const OPERATIONS = new Set(["receptionist","reception","recepciós","recepcios","location_manager","üzletvezető","uzletvezeto","store_manager","branch_manager","salon_manager","szalonvezető","szalonvezeto"]);

function roles(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).map(x => x.trim().toLowerCase()).filter(Boolean);
  const text = String(raw ?? "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map(String).map(x => x.trim().toLowerCase()).filter(Boolean);
  } catch {}
  return text.split(",").map(x => x.replace(/[\[\]"]/g, "").trim().toLowerCase()).filter(Boolean);
}

router.get("/", async (req: AuthRequest, res: Response) => {
  const roleList = roles(req.user?.role);
  const isAdmin = roleList.some(role => ADMIN.has(role));
  const isOperations = roleList.some(role => OPERATIONS.has(role));
  if (!isAdmin && !isOperations) {
    return res.status(403).json({ error: "A foglaláslista megtekintéséhez nincs jogosultság." });
  }

  const locationId = isAdmin ? null : (req.user?.location_id == null ? null : String(req.user.location_id));
  if (!isAdmin && !locationId) {
    return res.status(403).json({ error: "A felhasználóhoz nincs telephely rendelve." });
  }

  try {
    const r = await pool.query(
      `SELECT b.id,b.customer_name,b.service_id,b.employee_id,b.starts_at,b.ends_at,b.status
         FROM bookings b
         LEFT JOIN employees e ON e.id::text=b.employee_id::text
        WHERE ($1::uuid IS NULL OR e.location_id=$1::uuid)
        ORDER BY b.starts_at DESC
        LIMIT 200`,
      [locationId]
    );
    return res.json(r.rows);
  } catch (e) {
    console.error("❌ Bookings lekérési hiba:", e);
    return res.status(500).json({ error: "Nem sikerült lekérni a foglalásokat" });
  }
});

export default router;
