import { Router } from "express";
import pool from "../db";

/**
 * Publikus kijelző API (nem igényel login-t)
 * GET /api/signage/services
 * GET /api/signage/deals
 * GET /api/signage/professionals
 * GET /api/signage/daily
 */
const router = Router();

router.get("/services", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        s.id,
        s.name,
        st.name AS category_name,
        s.duration_min,
        s.price_from,
        COALESCE(o.enabled, true) AS enabled,
        COALESCE(o.priority, 0) AS priority,
        COALESCE(o.price_text_override, NULL) AS price_text_override
      FROM public.services s
      LEFT JOIN public.service_types st ON st.id = s.service_type_id
      LEFT JOIN public.signage_service_overrides o ON o.service_id = s.id
      WHERE COALESCE(s.is_active, TRUE)
        AND COALESCE(o.enabled, true) = true
      ORDER BY COALESCE(o.priority, 0) DESC, st.name NULLS LAST, s.name
      LIMIT 200;
    `);

    const services = rows.map((r: any) => {
      const base = r.price_from != null ? `${Number(r.price_from).toLocaleString("hu-HU")} Ft` : "";
      return {
        id: r.id,
        name: r.name,
        category: r.category_name || "",
        durationMin: r.duration_min ?? null,
        price_text: r.price_text_override || base,
        priority: Number(r.priority || 0),
      };
    });

    return res.json({
      source: "db:public.services",
      fetchedAt: new Date().toISOString(),
      services,
    });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

router.get("/deals", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT *
      FROM public.signage_deals
      WHERE active = true
        AND (valid_from IS NULL OR valid_from <= CURRENT_DATE)
        AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)
      ORDER BY priority DESC, updated_at DESC
      LIMIT 50;
    `);
    return res.json({ deals: rows });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

router.get("/professionals", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT *
      FROM public.signage_professionals
      WHERE available = true
      ORDER BY priority DESC, updated_at DESC
      LIMIT 30;
    `);
    return res.json({ professionals: rows });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// Napi idézet csomag (DB-ből, fallbackkel)
router.get("/daily", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT category, text, author, priority
      FROM public.signage_quotes
      WHERE active = true
      ORDER BY priority DESC, updated_at DESC
      LIMIT 200;
    `);

    const byCat: Record<string, any[]> = { fitness: [], beauty: [], general: [] };
    for (const r of rows) {
      if (byCat[r.category]) byCat[r.category].push(r);
    }

    const pick = (arr: any[], fallback: string) => {
      if (!arr.length) return { text: fallback, author: "" };
      const d = new Date();
      const seed = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
      const item = arr[seed % arr.length];
      return { text: item.text, author: item.author || "" };
    };

    return res.json({
      date: new Date().toISOString().slice(0, 10),
      fitness: pick(byCat.fitness, "A fegyelem akkor is dolgozik, amikor a motiváció eltűnik."),
      beauty: pick(byCat.beauty, "A konzisztens rutin többet ér, mint a ritka csodamegoldás."),
      general: pick(byCat.general, "A minőség a részletekben lakik: technika, higiénia, élmény."),
    });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

export default router;
