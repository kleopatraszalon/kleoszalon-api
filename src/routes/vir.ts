import { Router, Response } from "express";
import pool from "../db";
import { AuthRequest, requireAuth } from "../middleware/auth";
import { parseRoleKeys } from "../security/roles";
import receiptComplianceRouter from "./receiptCompliance";
import deviceControlRouter from "./deviceControl";
import deviceBridgeResultRouter from "./deviceBridgeResult";
import fitnessRouter, { fitnessOticBridgeRouter } from "./fitness";
import fitnessLockerRouter, { fitnessLockerBridgeRouter } from "./fitnessLockers";
import migrationCenterRouter from "./migrationCenter";
import virManagementRouter from "./virManagement";
import virIntelligenceRouter from "./virIntelligence";
import virP1Router from "./virP1";

const router = Router();
// A helyi OTIC és locker bridge saját, forgatható tokennel hitelesít; nem felhasználói JWT-vel.
router.use("/fitness/otic-bridge", fitnessOticBridgeRouter);
router.use("/fitness/locker-bridge", fitnessLockerBridgeRouter);
router.use(requireAuth);
router.use("/management", virManagementRouter);
router.use("/intelligence", virIntelligenceRouter);
router.use("/p1", virP1Router);
router.use("/migration-center", migrationCenterRouter);
router.use("/receipt-compliance", receiptComplianceRouter);
router.use("/device-control", deviceBridgeResultRouter);
router.use("/device-control", deviceControlRouter);
router.use("/fitness/lockers", fitnessLockerRouter);
router.use("/fitness", fitnessRouter);

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

/**
 * VIR adatscope:
 * - admin: kérhet egy konkrét telephelyet vagy locationId nélkül összesítést;
 * - minden más szerepkör: kizárólag a tokenben rögzített saját telephely.
 *
 * A kliens által küldött locationId soha nem lehet fallback egy nem admin
 * felhasználónál, mert azzal másik szalon adatai közvetlen API-hívással
 * lekérdezhetők lennének.
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

router.get("/dashboard", async (req: AuthRequest, res: Response) => {
  try {
    const query = (req.query || {}) as VirQueryParams;
    const today = new Date();
    const defaultTo = today.toISOString().slice(0, 10);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);

    const from = parseDateInput(query.from, monthStart);
    const to = parseDateInput(query.to, defaultTo);
    const locationId = getScopedLocationId(req, res);
    if (locationId === undefined) return;

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

router.get("/revenue-series", async (req: AuthRequest, res: Response) => {
  try {
    const query = (req.query || {}) as VirQueryParams;
    const today = new Date();
    const defaultTo = today.toISOString().slice(0, 10);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);

    const from = parseDateInput(query.from, monthStart);
    const to = parseDateInput(query.to, defaultTo);
    const locationId = getScopedLocationId(req, res);
    if (locationId === undefined) return;

    const { rows } = await pool.query(
      `SELECT * FROM public.vir_revenue_series($1::date, $2::date, $3::uuid) ORDER BY day`,
      [from, to, locationId]
    );
    return res.json({ ok: true, rows });
  } catch (error) {
    return res.status(500).json({ ok: false, error: toErrorMessage(error) });
  }
});

router.get("/top-services", async (req: AuthRequest, res: Response) => {
  try {
    const query = (req.query || {}) as VirQueryParams;
    const limit = parseLimit(query.limit, 10, 50);
    const locationId = getScopedLocationId(req, res);
    if (locationId === undefined) return;

    const { rows } = await pool.query(
      `SELECT
         s.id AS service_id,
         s.name AS service_name,
         COUNT(DISTINCT a.id)::int AS bookings_count,
         COALESCE(SUM(COALESCE(aps.price,0)),0)::numeric(14,2) AS revenue_total
       FROM appointment_services aps
       JOIN appointments a ON a.id=aps.appointment_id
       JOIN services s ON s.id=aps.service_id
       WHERE ($1::uuid IS NULL OR a.location_id=$1::uuid)
       GROUP BY s.id,s.name
       ORDER BY revenue_total DESC,bookings_count DESC,s.name
       LIMIT $2::integer`,
      [locationId, limit]
    );
    return res.json({ ok: true, rows });
  } catch (error) {
    return res.status(500).json({ ok: false, error: toErrorMessage(error) });
  }
});

router.get("/top-staff", async (req: AuthRequest, res: Response) => {
  try {
    const query = (req.query || {}) as VirQueryParams;
    const limit = parseLimit(query.limit, 10, 50);
    const locationId = getScopedLocationId(req, res);
    if (locationId === undefined) return;

    const { rows } = await pool.query(
      `SELECT
         e.id AS employee_id,
         e.full_name,
         e.short_name,
         COUNT(DISTINCT a.id)::int AS appointments_count,
         COALESCE(SUM(COALESCE(aps.price,0)),0)::numeric(14,2) AS revenue_total
       FROM appointments a
       JOIN employees e ON e.id=a.employee_id
       LEFT JOIN appointment_services aps ON aps.appointment_id=a.id
       WHERE ($1::uuid IS NULL OR a.location_id=$1::uuid)
       GROUP BY e.id,e.full_name,e.short_name
       ORDER BY revenue_total DESC,appointments_count DESC,e.full_name
       LIMIT $2::integer`,
      [locationId, limit]
    );
    return res.json({ ok: true, rows });
  } catch (error) {
    return res.status(500).json({ ok: false, error: toErrorMessage(error) });
  }
});

router.get("/source-performance", async (req: AuthRequest, res: Response) => {
  try {
    const locationId = getScopedLocationId(req, res);
    if (locationId === undefined) return;
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

router.get("/cancellation-stats", async (req: AuthRequest, res: Response) => {
  try {
    const query = (req.query || {}) as VirQueryParams;
    const today = new Date();
    const defaultTo = today.toISOString().slice(0, 10);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);

    const from = parseDateInput(query.from, monthStart);
    const to = parseDateInput(query.to, defaultTo);
    const locationId = getScopedLocationId(req, res);
    if (locationId === undefined) return;

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

router.get("/kiosk-conversion", async (req: AuthRequest, res: Response) => {
  try {
    const query = (req.query || {}) as VirQueryParams;
    const today = new Date();
    const defaultTo = today.toISOString().slice(0, 10);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);

    const from = parseDateInput(query.from, monthStart);
    const to = parseDateInput(query.to, defaultTo);
    const locationId = getScopedLocationId(req, res);
    if (locationId === undefined) return;

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

router.get("/signage-impact", async (req: AuthRequest, res: Response) => {
  try {
    const locationId = getScopedLocationId(req, res);
    if (locationId === undefined) return;
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
