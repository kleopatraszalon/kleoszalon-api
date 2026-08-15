import { Router, Response } from "express";
import pool from "../db";
import { AuthRequest, requireAuth } from "../middleware/auth";
import { parseRoleKeys } from "../security/roles";

const router = Router();
router.use(requireAuth);

type VirQueryParams = {
  from?: string;
  to?: string;
  locationId?: string;
  limit?: string;
};

type CacheEntry = { expiresAt: number; value: unknown };
const DASHBOARD_CACHE_TTL_MS = Math.max(1000, Number(process.env.VIR_DASHBOARD_CACHE_TTL_MS || 20000));
const dashboardCache = new Map<string, CacheEntry>();

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

function defaultPeriod(query: VirQueryParams) {
  const today = new Date();
  const defaultTo = today.toISOString().slice(0, 10);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);
  return {
    from: parseDateInput(query.from, monthStart),
    to: parseDateInput(query.to, defaultTo),
  };
}

function previousPeriod(from: string, to: string) {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  const dayDiff = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000) + 1);
  const prevTo = new Date(start);
  prevTo.setUTCDate(prevTo.getUTCDate() - 1);
  const prevFrom = new Date(prevTo);
  prevFrom.setUTCDate(prevFrom.getUTCDate() - (dayDiff - 1));
  return { from: prevFrom.toISOString().slice(0, 10), to: prevTo.toISOString().slice(0, 10) };
}

/**
 * VIR adatscope:
 * - admin: kérhet egy konkrét telephelyet vagy locationId nélkül összesítést;
 * - minden más szerepkör: kizárólag a tokenben rögzített saját telephely.
 */
function getScopedLocationId(req: AuthRequest, res: Response): string | null | undefined {
  const query = (req.query || {}) as VirQueryParams;
  const requestedLocationId = query.locationId ? String(query.locationId).trim() : null;
  const roles = parseRoleKeys(req.user?.role);

  if (roles.includes("admin")) return requestedLocationId || null;

  const userLocationId =
    req.user?.location_id !== undefined && req.user?.location_id !== null
      ? String(req.user.location_id).trim()
      : "";

  if (!userLocationId) {
    res.status(403).json({ ok: false, error: "A felhasználóhoz nincs telephely rendelve." });
    return undefined;
  }

  return userLocationId;
}

async function queryTopServices(locationId: string | null, from: string, to: string, limit: number) {
  const { rows } = await pool.query(
    `SELECT
       s.id AS service_id,
       s.name AS service_name,
       COUNT(DISTINCT a.id)::int AS bookings_count,
       COALESCE(SUM(COALESCE(aps.price,0)),0)::numeric(14,2) AS revenue_total,
       CASE WHEN COUNT(aps.id)=0 THEN 0 ELSE ROUND(AVG(COALESCE(aps.price,0))::numeric,2) END AS avg_price
     FROM appointment_services aps
     JOIN appointments a ON a.id=aps.appointment_id
     JOIN services s ON s.id=aps.service_id
     WHERE ($1::uuid IS NULL OR a.location_id=$1::uuid)
       AND a.start_time >= $2::date
       AND a.start_time < ($3::date + INTERVAL '1 day')
     GROUP BY s.id,s.name
     ORDER BY revenue_total DESC,bookings_count DESC,s.name
     LIMIT $4::integer`,
    [locationId, from, to, limit]
  );
  return rows;
}

async function queryTopStaff(locationId: string | null, from: string, to: string, limit: number) {
  const { rows } = await pool.query(
    `SELECT
       e.id AS employee_id,
       e.full_name,
       e.short_name,
       COUNT(DISTINCT a.id)::int AS appointments_count,
       COUNT(DISTINCT a.id) FILTER (WHERE LOWER(COALESCE(a.status,'')) IN ('completed','done','finished'))::int AS completed_count,
       COALESCE(SUM(COALESCE(aps.price,0)),0)::numeric(14,2) AS revenue_total,
       0::numeric AS revenue_per_hour
     FROM appointments a
     JOIN employees e ON e.id=a.employee_id
     LEFT JOIN appointment_services aps ON aps.appointment_id=a.id
     WHERE ($1::uuid IS NULL OR a.location_id=$1::uuid)
       AND a.start_time >= $2::date
       AND a.start_time < ($3::date + INTERVAL '1 day')
     GROUP BY e.id,e.full_name,e.short_name
     ORDER BY revenue_total DESC,appointments_count DESC,e.full_name
     LIMIT $4::integer`,
    [locationId, from, to, limit]
  );
  return rows;
}

router.get("/dashboard-fast", async (req: AuthRequest, res: Response) => {
  try {
    const query = (req.query || {}) as VirQueryParams;
    const { from, to } = defaultPeriod(query);
    const prev = previousPeriod(from, to);
    const locationId = getScopedLocationId(req, res);
    if (locationId === undefined) return;
    const limit = parseLimit(query.limit, 10, 50);
    const cacheKey = `${locationId || "all"}|${from}|${to}|${limit}`;
    const now = Date.now();
    const cached = dashboardCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      res.setHeader("X-Kleo-Cache", "HIT");
      return res.json(cached.value);
    }

    const [summaryQ, prevSummaryQ, revenueQ, topServices, topStaff, sourceQ, cancelQ, kioskQ, signageQ] = await Promise.all([
      pool.query(`SELECT * FROM public.vir_dashboard_summary($1::date, $2::date, $3::uuid)`, [from, to, locationId]),
      pool.query(`SELECT * FROM public.vir_dashboard_summary($1::date, $2::date, $3::uuid)`, [prev.from, prev.to, locationId]),
      pool.query(`SELECT * FROM public.vir_revenue_series($1::date, $2::date, $3::uuid) ORDER BY day`, [from, to, locationId]),
      queryTopServices(locationId, from, to, limit),
      queryTopStaff(locationId, from, to, limit),
      pool.query(
        `SELECT source_channel, location_id, appointments_count, completed_count, cancelled_count, no_show_count, revenue_total, paid_total
         FROM public.vw_vir_source_performance
         WHERE ($1::uuid IS NULL OR location_id = $1::uuid)
         ORDER BY revenue_total DESC NULLS LAST, appointments_count DESC`,
        [locationId]
      ),
      pool.query(
        `SELECT day, location_id, total_appointments, cancelled_count, no_show_count, cancellation_rate_percent, no_show_rate_percent
         FROM public.vw_vir_cancellation_stats
         WHERE day BETWEEN $1::date AND $2::date
           AND ($3::uuid IS NULL OR location_id = $3::uuid)
         ORDER BY day`,
        [from, to, locationId]
      ),
      pool.query(
        `SELECT day, location_id, kiosk_appointments, kiosk_completed, kiosk_revenue
         FROM public.vw_vir_kiosk_conversion
         WHERE day BETWEEN $1::date AND $2::date
           AND ($3::uuid IS NULL OR location_id = $3::uuid)
         ORDER BY day`,
        [from, to, locationId]
      ),
      pool.query(
        `SELECT deal_id, title, location_id, active_from, active_to, appointments_during_campaign, revenue_during_campaign
         FROM public.vw_vir_signage_campaign_impact
         WHERE ($1::uuid IS NULL OR location_id = $1::uuid OR location_id IS NULL)
         ORDER BY active_from DESC, revenue_during_campaign DESC NULLS LAST`,
        [locationId]
      ),
    ]);

    const payload = {
      ok: true,
      from,
      to,
      previous: prev,
      summary: summaryQ.rows[0] || null,
      prevSummary: prevSummaryQ.rows[0] || null,
      revenueSeries: revenueQ.rows,
      topServices,
      topStaff,
      sourceRows: sourceQ.rows,
      cancelRows: cancelQ.rows,
      kioskRows: kioskQ.rows,
      signageRows: signageQ.rows,
      cacheTtlMs: DASHBOARD_CACHE_TTL_MS,
    };
    dashboardCache.set(cacheKey, { expiresAt: now + DASHBOARD_CACHE_TTL_MS, value: payload });
    if (dashboardCache.size > 250) {
      for (const [key, entry] of dashboardCache) {
        if (entry.expiresAt <= now) dashboardCache.delete(key);
      }
    }
    res.setHeader("X-Kleo-Cache", "MISS");
    return res.json(payload);
  } catch (error) {
    return res.status(500).json({ ok: false, error: toErrorMessage(error) });
  }
});

router.get("/dashboard", async (req: AuthRequest, res: Response) => {
  try {
    const query = (req.query || {}) as VirQueryParams;
    const { from, to } = defaultPeriod(query);
    const locationId = getScopedLocationId(req, res);
    if (locationId === undefined) return;
    const { rows } = await pool.query(`SELECT * FROM public.vir_dashboard_summary($1::date, $2::date, $3::uuid)`, [from, to, locationId]);
    return res.json({ ok: true, summary: rows[0] || { revenue_total: 0, paid_total: 0, appointments_count: 0, completed_count: 0, cancelled_count: 0, no_show_count: 0, avg_basket: 0, cancellation_rate_percent: 0, no_show_rate_percent: 0 } });
  } catch (error) { return res.status(500).json({ ok: false, error: toErrorMessage(error) }); }
});

router.get("/revenue-series", async (req: AuthRequest, res: Response) => {
  try {
    const query = (req.query || {}) as VirQueryParams;
    const { from, to } = defaultPeriod(query);
    const locationId = getScopedLocationId(req, res);
    if (locationId === undefined) return;
    const { rows } = await pool.query(`SELECT * FROM public.vir_revenue_series($1::date, $2::date, $3::uuid) ORDER BY day`, [from, to, locationId]);
    return res.json({ ok: true, rows });
  } catch (error) { return res.status(500).json({ ok: false, error: toErrorMessage(error) }); }
});

router.get("/top-services", async (req: AuthRequest, res: Response) => {
  try {
    const query = (req.query || {}) as VirQueryParams;
    const { from, to } = defaultPeriod(query);
    const limit = parseLimit(query.limit, 10, 50);
    const locationId = getScopedLocationId(req, res);
    if (locationId === undefined) return;
    return res.json({ ok: true, rows: await queryTopServices(locationId, from, to, limit) });
  } catch (error) { return res.status(500).json({ ok: false, error: toErrorMessage(error) }); }
});

router.get("/top-staff", async (req: AuthRequest, res: Response) => {
  try {
    const query = (req.query || {}) as VirQueryParams;
    const { from, to } = defaultPeriod(query);
    const limit = parseLimit(query.limit, 10, 50);
    const locationId = getScopedLocationId(req, res);
    if (locationId === undefined) return;
    return res.json({ ok: true, rows: await queryTopStaff(locationId, from, to, limit) });
  } catch (error) { return res.status(500).json({ ok: false, error: toErrorMessage(error) }); }
});

router.get("/source-performance", async (req: AuthRequest, res: Response) => {
  try {
    const locationId = getScopedLocationId(req, res);
    if (locationId === undefined) return;
    const { rows } = await pool.query(`SELECT source_channel, location_id, appointments_count, completed_count, cancelled_count, no_show_count, revenue_total, paid_total FROM public.vw_vir_source_performance WHERE ($1::uuid IS NULL OR location_id = $1::uuid) ORDER BY revenue_total DESC NULLS LAST, appointments_count DESC`, [locationId]);
    return res.json({ ok: true, rows });
  } catch (error) { return res.status(500).json({ ok: false, error: toErrorMessage(error) }); }
});

router.get("/cancellation-stats", async (req: AuthRequest, res: Response) => {
  try {
    const query = (req.query || {}) as VirQueryParams;
    const { from, to } = defaultPeriod(query);
    const locationId = getScopedLocationId(req, res);
    if (locationId === undefined) return;
    const { rows } = await pool.query(`SELECT day, location_id, total_appointments, cancelled_count, no_show_count, cancellation_rate_percent, no_show_rate_percent FROM public.vw_vir_cancellation_stats WHERE day BETWEEN $1::date AND $2::date AND ($3::uuid IS NULL OR location_id = $3::uuid) ORDER BY day`, [from, to, locationId]);
    return res.json({ ok: true, rows });
  } catch (error) { return res.status(500).json({ ok: false, error: toErrorMessage(error) }); }
});

router.get("/kiosk-conversion", async (req: AuthRequest, res: Response) => {
  try {
    const query = (req.query || {}) as VirQueryParams;
    const { from, to } = defaultPeriod(query);
    const locationId = getScopedLocationId(req, res);
    if (locationId === undefined) return;
    const { rows } = await pool.query(`SELECT day, location_id, kiosk_appointments, kiosk_completed, kiosk_revenue FROM public.vw_vir_kiosk_conversion WHERE day BETWEEN $1::date AND $2::date AND ($3::uuid IS NULL OR location_id = $3::uuid) ORDER BY day`, [from, to, locationId]);
    return res.json({ ok: true, rows });
  } catch (error) { return res.status(500).json({ ok: false, error: toErrorMessage(error) }); }
});

router.get("/signage-impact", async (req: AuthRequest, res: Response) => {
  try {
    const locationId = getScopedLocationId(req, res);
    if (locationId === undefined) return;
    const { rows } = await pool.query(`SELECT deal_id, title, location_id, active_from, active_to, appointments_during_campaign, revenue_during_campaign FROM public.vw_vir_signage_campaign_impact WHERE ($1::uuid IS NULL OR location_id = $1::uuid OR location_id IS NULL) ORDER BY active_from DESC, revenue_during_campaign DESC NULLS LAST`, [locationId]);
    return res.json({ ok: true, rows });
  } catch (error) { return res.status(500).json({ ok: false, error: toErrorMessage(error) }); }
});

export default router;
