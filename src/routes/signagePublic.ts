import { Router } from "express";
import pool from "../db";

/**
 * Public Signage API (NO AUTH)
 *
 * Mounted under: /api/signage
 *
 * Endpoints used by SignagePage.tsx:
 *  - GET /services        -> { services: ServiceItem[], fetchedAt }
 *  - GET /deals           -> { deals: Deal[] }
 *  - GET /videos          -> { videos: VideoItem[] }
 *  - GET /daily           -> { fitness: Quote|null, beauty: Quote|null }
 *  - GET /professionals   -> { professionals: Professional[] }
 *
 * IMPORTANT:
 *  - Do NOT require cookie/JWT here (display page must work without login)
 *  - Always return JSON
 */

const router = Router();

// -----------------------------
// Helpers
// -----------------------------
const nowIso = () => new Date().toISOString();

function safeText(v: any) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}
function safeNum(v: any, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// -----------------------------
// Services (public)
// -----------------------------
router.get("/services", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT
        s.id::text AS id,
        s.name,
        COALESCE(s.category, '') AS category,
        s.duration_min,
        COALESCE(s.price_text, '') AS price_text,
        COALESCE(s.priority, 0) AS priority
      FROM public.signage_services s
      LEFT JOIN public.signage_service_overrides o
        ON o.service_id = s.id
      WHERE COALESCE(s.show, true) = true
        AND COALESCE(o.enabled, true) = true
      ORDER BY COALESCE(s.priority, 0) DESC, s.updated_at DESC
      LIMIT 200;
      `
    );

    const services = rows.map((r: any) => ({
      id: safeText(r.id),
      name: safeText(r.name),
      category: safeText(r.category),
      durationMin: r.duration_min == null ? null : safeNum(r.duration_min, null as any),
      price_text: safeText(r.price_text),
      priority: safeNum(r.priority, 0),
    }));

    res.json({ services, fetchedAt: nowIso() });
  } catch (e: any) {
    res.status(500).json({ error: safeText(e?.message || e) });
  }
});

// -----------------------------
// Deals (public)
// -----------------------------
router.get("/deals", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT
        id::text AS id,
        title,
        COALESCE(subtitle, '') AS subtitle,
        COALESCE(price_text, '') AS price_text,
        valid_from,
        valid_to,
        active,
        COALESCE(priority, 0) AS priority
      FROM public.signage_deals
      WHERE COALESCE(active, true) = true
        AND (valid_from IS NULL OR valid_from <= CURRENT_DATE)
        AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)
      ORDER BY COALESCE(priority, 0) DESC, updated_at DESC
      LIMIT 20;
      `
    );

    res.json({ deals: rows });
  } catch (e: any) {
    res.status(500).json({ error: safeText(e?.message || e) });
  }
});

// -----------------------------
// Videos (public)
// -----------------------------
router.get("/videos", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT
        id::text AS id,
        youtube_id,
        COALESCE(title, '') AS title,
        COALESCE(duration_sec, 60) AS duration_sec,
        COALESCE(priority, 0) AS priority
      FROM public.signage_videos
      WHERE COALESCE(enabled, true) = true
      ORDER BY COALESCE(priority, 0) DESC, updated_at DESC
      LIMIT 50;
      `
    );

    res.json({ videos: rows });
  } catch (e: any) {
    res.status(500).json({ error: safeText(e?.message || e) });
  }
});

// -----------------------------
// Daily (ticker quotes) (public)
// -----------------------------
router.get("/daily", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT
        id::text AS id,
        category,
        text,
        COALESCE(author, '') AS author,
        COALESCE(priority, 0) AS priority
      FROM public.signage_quotes
      WHERE COALESCE(enabled, true) = true
        AND category IN ('fitness', 'beauty')
      ORDER BY category, COALESCE(priority, 0) DESC, updated_at DESC;
      `
    );

    const pick = (cat: string) => rows.find((r: any) => r.category === cat) || null;
    res.json({
      fitness: pick("fitness"),
      beauty: pick("beauty"),
      fetchedAt: nowIso(),
    });
  } catch (e: any) {
    res.status(500).json({ error: safeText(e?.message || e) });
  }
});

// -----------------------------
// Professionals (public)
// -----------------------------
router.get("/professionals", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT
        id::text AS id,
        name,
        COALESCE(title, '') AS title,
        COALESCE(note, '') AS note,
        COALESCE(priority, 0) AS priority,
        COALESCE(is_free, true) AS is_free
      FROM public.signage_professionals
      WHERE COALESCE(show, true) = true
      ORDER BY COALESCE(priority, 0) DESC, COALESCE(is_free, true) DESC, updated_at DESC
      LIMIT 30;
      `
    );

    const professionals = rows.map((r: any) => ({
      id: safeText(r.id),
      name: safeText(r.name),
      title: safeText(r.title),
      note: safeText(r.note),
      priority: safeNum(r.priority, 0),
      is_free: !!r.is_free,
      available: !!r.is_free, // legacy alias for older UIs
    }));

    res.json({ professionals });
  } catch (e: any) {
    res.status(500).json({ error: safeText(e?.message || e) });
  }
});

export default router;
