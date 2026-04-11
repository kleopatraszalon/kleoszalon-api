import { Router, Response } from "express";
import pool from "../db";
import { AuthRequest, requireAuth } from "../middleware/auth";

const router = Router();

type VirQueryParams = {
  from?: string;
  to?: string;
  locationId?: string;
  limit?: string;
};

function parseDateInput(value: string | undefined, fallback: string): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return fallback;
  return value;
}

function parseLimit(value: string | undefined, fallback = 10, max = 100): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "unknown_error";
}

function getScopedLocationId(req: AuthRequest): string | null {
  const query = (req.query || {}) as VirQueryParams;
  const requestedLocationId = query.locationId || null;

  if ((req.user?.role || "").toLowerCase() === "admin") {
    return requestedLocationId;
  }

  const userLocationId =
    req.user?.location_id !== undefined && req.user?.location_id !== null
      ? String(req.user.location_id)
      : null;

  return userLocationId || requestedLocationId || null;
}

router.get("/dashboard", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const query = (req.query || {}) as VirQueryParams;
    const today = new Date();
    const defaultTo = today.toISOString().slice(0, 10);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);

    const from = parseDateInput(query.from, monthStart);
    const to = parseDateInput(query.to, defaultTo);
    const locationId = getScopedLocationId(req);

    const { rows } = await pool.query(
      `SELECT * FROM public.vir_dashboard_summary($1::date, $2::date, $3::uuid)`,
      [from, to, locationId]
    );

    return res.json({
      ok: true,
      summary: rows[0] || {
        revenue_total: 0,
        paid_total: 0,
        appointments_count: 0,
        completed_count: 0,
        cancelled_count: 0,
        no_show_count: 0,
        avg_basket: 0,
        cancellation_rate_percent: 0,
        no_show_rate_percent: 0,
      },
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: toErrorMessage(error) });
  }
});

router.get("/revenue-series", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const query = (req.query || {}) as VirQueryParams;
    const today = new Date();
    const defaultTo = today.toISOString().slice(0, 10);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);

    const from = parseDateInput(query.from, monthStart);
    const to = parseDateInput(query.to, defaultTo);
    const locationId = getScopedLocationId(req);

    const { rows } = await pool.query(
      `SELECT * FROM public.vir_revenue_series($1::date, $2::date, $3::uuid) ORDER BY day`,
      [from, to, locationId]
    );
    return res.json({ ok: true, rows });
  } catch (error) {
    return res.status(500).json({ ok: false, error: toErrorMessage(error) });
  }
});

router.get("/top-services", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const query = (req.query || {}) as VirQueryParams;
    const limit = parseLimit(query.limit, 10, 50);
    const { rows } = await pool.query(`SELECT * FROM public.vir_top_services($1::integer)`, [limit]);
    return res.json({ ok: true, rows });
  } catch (error) {
    return res.status(500).json({ ok: false, error: toErrorMessage(error) });
  }
});

router.get("/top-staff", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const query = (req.query || {}) as VirQueryParams;
    const limit = parseLimit(query.limit, 10, 50);
    const { rows } = await pool.query(`SELECT * FROM public.vir_top_staff($1::integer)`, [limit]);
    return res.json({ ok: true, rows });
  } catch (error) {
    return res.status(500).json({ ok: false, error: toErrorMessage(error) });
  }
});

router.get("/source-performance", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const locationId = getScopedLocationId(req);
    const { rows } = await pool.query(
      `SELECT source_channel, location_id, appointments_count, completed_count, cancelled_count, no_show_count, revenue_total, paid_total
       FROM public.vw_vir_source_performance
       WHERE ($1::uuid IS NULL OR location_id = $1::uuid)
       ORDER BY revenue_total DESC NULLS LAST, appointments_count DESC`,
      [locationId]
    );
    return res.json({ ok: true, rows });
  } catch (error) {
    return res.status(500).json({ ok: false, error: toErrorMessage(error) });
  }
});

router.get("/cancellation-stats", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const query = (req.query || {}) as VirQueryParams;
    const today = new Date();
    const defaultTo = today.toISOString().slice(0, 10);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);

    const from = parseDateInput(query.from, monthStart);
    const to = parseDateInput(query.to, defaultTo);
    const locationId = getScopedLocationId(req);

    const { rows } = await pool.query(
      `SELECT day, location_id, total_appointments, cancelled_count, no_show_count, cancellation_rate_percent, no_show_rate_percent
       FROM public.vw_vir_cancellation_stats
       WHERE day BETWEEN $1::date AND $2::date
         AND ($3::uuid IS NULL OR location_id = $3::uuid)
       ORDER BY day`,
      [from, to, locationId]
    );
    return res.json({ ok: true, rows });
  } catch (error) {
    return res.status(500).json({ ok: false, error: toErrorMessage(error) });
  }
});

router.get("/kiosk-conversion", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const query = (req.query || {}) as VirQueryParams;
    const today = new Date();
    const defaultTo = today.toISOString().slice(0, 10);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);

    const from = parseDateInput(query.from, monthStart);
    const to = parseDateInput(query.to, defaultTo);
    const locationId = getScopedLocationId(req);

    const { rows } = await pool.query(
      `SELECT day, location_id, kiosk_appointments, kiosk_completed, kiosk_revenue
       FROM public.vw_vir_kiosk_conversion
       WHERE day BETWEEN $1::date AND $2::date
         AND ($3::uuid IS NULL OR location_id = $3::uuid)
       ORDER BY day`,
      [from, to, locationId]
    );
    return res.json({ ok: true, rows });
  } catch (error) {
    return res.status(500).json({ ok: false, error: toErrorMessage(error) });
  }
});

router.get("/signage-impact", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const locationId = getScopedLocationId(req);
    const { rows } = await pool.query(
      `SELECT deal_id, title, location_id, active_from, active_to, appointments_during_campaign, revenue_during_campaign
       FROM public.vw_vir_signage_campaign_impact
       WHERE ($1::uuid IS NULL OR location_id = $1::uuid OR location_id IS NULL)
       ORDER BY active_from DESC, revenue_during_campaign DESC NULLS LAST`,
      [locationId]
    );
    return res.json({ ok: true, rows });
  } catch (error) {
    return res.status(500).json({ ok: false, error: toErrorMessage(error) });
  }
});

export default router;
