import { Router } from "express";
import { pool } from "../db";

/**
 * KIOSK PUBLIC API
 * - GET /api/kiosk/services?lang=hu
 *
 * Goal: be compatible with existing Kleopatra DB schema.
 * We do NOT assume legacy columns like `active`, `category`, `parent_id`, `base_duration_minutes`.
 * Canonical columns in your dump:
 *   services: id (int), name, description, price, duration_minutes, category_id, is_active
 *   service_categories: id (int), name
 */

export const kioskRouter = Router();

type KioskCategory = {
  id: string;
  name: string;
};

type KioskService = {
  id: string;
  name: string;
  description?: string | null;
  price: number;
  duration_minutes: number | null;
  category_id: string | null;
  category_name: string;
};

kioskRouter.get("/services", async (req, res) => {
  try {
    // lang is kept for future localization, but currently DB is HU.
    const language = String(req.query.lang || "hu");

    const q = `
      SELECT
        s.id::text                  AS id,
        s.name                      AS name,
        s.description               AS description,
        COALESCE(s.price, 0)::float AS price,
        NULLIF(s.duration_minutes, 0) AS duration_minutes,
        s.category_id::text         AS category_id,
        COALESCE(sc.name, 'Egyéb')  AS category_name
      FROM services s
      LEFT JOIN service_categories sc ON sc.id = s.category_id
      WHERE COALESCE(s.is_active, true) = true
      ORDER BY COALESCE(sc.name, 'Egyéb') ASC, s.name ASC
    `;

    const r = await pool.query(q);

    const services: KioskService[] = r.rows.map((row: any) => ({
      id: String(row.id),
      name: String(row.name),
      description: row.description ?? null,
      price: Number(row.price ?? 0),
      duration_minutes: row.duration_minutes == null ? null : Number(row.duration_minutes),
      category_id: row.category_id == null ? null : String(row.category_id),
      category_name: String(row.category_name || "Egyéb"),
    }));

    // categories derived from the returned services, stable ordering
    const catMap = new Map<string, KioskCategory>();
    for (const s of services) {
      const cid = s.category_id || "0";
      if (!catMap.has(cid)) {
        catMap.set(cid, { id: cid, name: s.category_name });
      }
    }
    const categories = Array.from(catMap.values());

    return res.json({ ok: true, language, categories, services });
  } catch (e: any) {
    console.error("Kiosk services hiba:", e);
    return res.status(500).json({ ok: false, error: "kiosk_services_failed" });
  }
});

export default kioskRouter;
