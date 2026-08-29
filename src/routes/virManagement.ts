import crypto from "crypto";
import { Router, Response } from "express";
import pool from "../db";
import { AuthRequest } from "../middleware/auth";
import { requireManagement } from "../middleware/requireRoles";
import { parseRoleKeys } from "../security/roles";

const router = Router();
router.use(requireManagement);

type Priority = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
type ActionStatus = "OPEN" | "IN_PROGRESS" | "BLOCKED" | "WAITING_APPROVAL" | "DONE";

type QueryParams = {
  date?: string;
  locationId?: string;
  status?: string;
  priority?: string;
  source?: string;
  limit?: string;
};

const PRIORITIES = new Set<Priority>(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);
const STATUSES = new Set<ActionStatus>(["OPEN", "IN_PROGRESS", "BLOCKED", "WAITING_APPROVAL", "DONE"]);

let schemaReady: Promise<void> | null = null;

function ensureActionCenterSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS vir_action_items (
          id uuid PRIMARY KEY,
          location_id uuid NULL,
          source varchar(64) NOT NULL DEFAULT 'MANUAL',
          source_ref text NULL,
          title text NOT NULL,
          description text NOT NULL DEFAULT '',
          priority varchar(16) NOT NULL DEFAULT 'MEDIUM',
          status varchar(32) NOT NULL DEFAULT 'OPEN',
          assignee_name text NULL,
          due_at timestamptz NULL,
          source_route text NULL,
          evidence text NULL,
          requires_approval boolean NOT NULL DEFAULT false,
          created_by text NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_by text NULL,
          updated_at timestamptz NOT NULL DEFAULT now(),
          completed_at timestamptz NULL,
          CONSTRAINT vir_action_items_priority_chk CHECK (priority IN ('CRITICAL','HIGH','MEDIUM','LOW')),
          CONSTRAINT vir_action_items_status_chk CHECK (status IN ('OPEN','IN_PROGRESS','BLOCKED','WAITING_APPROVAL','DONE'))
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS vir_action_items_status_idx ON vir_action_items(status, priority, due_at)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS vir_action_items_location_idx ON vir_action_items(location_id, status)`);
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS vir_action_items_source_ref_uidx ON vir_action_items(source, source_ref) WHERE source_ref IS NOT NULL`);
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

function dateValue(value: unknown, fallback: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : fallback;
}

function positiveLimit(value: unknown, fallback = 100, max = 300) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : fallback;
}

function getScopedLocationId(req: AuthRequest, res: Response): string | null | undefined {
  const requested = String((req.query as QueryParams)?.locationId || "").trim();
  const own = String(req.user?.location_id || "").trim();
  const roles = parseRoleKeys(req.user?.role);
  if (roles.includes("admin") || roles.includes("manager")) return requested || null;
  if (!own) {
    res.status(403).json({ ok: false, error: "A felhasználóhoz nincs telephely rendelve." });
    return undefined;
  }
  return own;
}

function actor(req: AuthRequest) {
  return String(req.user?.email || req.user?.id || "management");
}

function cleanPriority(value: unknown, fallback: Priority = "MEDIUM"): Priority {
  const normalized = String(value || "").toUpperCase() as Priority;
  return PRIORITIES.has(normalized) ? normalized : fallback;
}

function cleanStatus(value: unknown, fallback: ActionStatus = "OPEN"): ActionStatus {
  const normalized = String(value || "").toUpperCase() as ActionStatus;
  return STATUSES.has(normalized) ? normalized : fallback;
}

async function loadDailyPlan(date: string, locationId: string | null) {
  const [fallbackResult, shiftResult] = await Promise.all([
    pool.query(
      `SELECT target_value FROM vir_kpi_targets
       WHERE kpi_key='default_revenue_per_work_hour'
         AND (location_id IS NULL OR location_id::text=$1::text)
       ORDER BY (location_id IS NOT NULL) DESC LIMIT 1`,
      [locationId]
    ),
    pool.query(
      `SELECT
         GREATEST(0, ROUND(EXTRACT(EPOCH FROM (s.ends_at-s.starts_at))/60)-COALESCE(s.break_minutes,0))::int scheduled_minutes,
         COALESCE(p.revenue_target_per_hour,0)::numeric revenue_target_per_hour
       FROM work_shifts s
       JOIN employees e ON e.id=s.employee_id
       LEFT JOIN hr_positions p ON p.id=e.position_id
       WHERE s.work_date=$1::date AND s.status<>'cancelled'
         AND ($2::text IS NULL OR COALESCE(s.location_id::text,e.location_id::text)=$2::text)`,
      [date, locationId]
    ),
  ]);

  const defaultHourly = Math.max(0, Number(fallbackResult.rows[0]?.target_value || 0));
  let scheduledMinutes = 0;
  let target = 0;
  for (const row of shiftResult.rows) {
    const minutes = Math.max(0, Number(row.scheduled_minutes || 0));
    const hourly = Math.max(0, Number(row.revenue_target_per_hour || 0)) || defaultHourly;
    scheduledMinutes += minutes;
    target += Math.round((minutes / 60) * hourly);
  }
  return {
    scheduled_minutes: scheduledMinutes,
    scheduled_hours: Number((scheduledMinutes / 60).toFixed(2)),
    daily_revenue_target: target,
    default_revenue_per_work_hour: defaultHourly,
  };
}

async function upsertSignalAction(input: {
  locationId: string | null;
  sourceRef: string;
  title: string;
  description: string;
  priority: Priority;
  sourceRoute: string;
  actorName: string;
}) {
  await pool.query(
    `INSERT INTO vir_action_items (
       id, location_id, source, source_ref, title, description, priority, status,
       source_route, requires_approval, created_by, updated_by
     ) VALUES ($1::uuid,$2::uuid,'VIR_SIGNAL',$3,$4,$5,$6,'OPEN',$7,false,$8,$8)
     ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL
     DO UPDATE SET
       title=EXCLUDED.title,
       description=EXCLUDED.description,
       priority=CASE WHEN vir_action_items.status='DONE' THEN vir_action_items.priority ELSE EXCLUDED.priority END,
       source_route=EXCLUDED.source_route,
       updated_by=EXCLUDED.updated_by,
       updated_at=now()`,
    [crypto.randomUUID(), input.locationId, input.sourceRef, input.title, input.description, input.priority, input.sourceRoute, input.actorName]
  );
}

async function syncOperationalSignals(req: AuthRequest, date: string, locationId: string | null) {
  const { rows } = await pool.query(
    `SELECT * FROM public.vir_dashboard_summary($1::date, $1::date, $2::uuid)`,
    [date, locationId]
  );
  const summary = rows[0] || {};
  const plan = await loadDailyPlan(date, locationId).catch(() => ({
    scheduled_minutes: 0,
    scheduled_hours: 0,
    daily_revenue_target: 0,
    default_revenue_per_work_hour: 0,
  }));
  const revenue = Number(summary.revenue_total || 0);
  const noShowRate = Number(summary.no_show_rate_percent || 0);
  const cancellationRate = Number(summary.cancellation_rate_percent || 0);
  const locationKey = locationId || "all";
  const actorName = actor(req);
  const writes: Promise<void>[] = [];

  if (plan.daily_revenue_target > 0 && revenue < plan.daily_revenue_target * 0.9) {
    const gap = Math.max(0, Math.round(plan.daily_revenue_target - revenue));
    writes.push(upsertSignalAction({
      locationId,
      sourceRef: `revenue-gap:${date}:${locationKey}`,
      title: "Napi árbevételi terv elmaradás",
      description: `A napi tervhez képest ${gap.toLocaleString("hu-HU")} Ft hiányzik. Vizsgáld meg a szabad kapacitást és az aznapi értékesítési lehetőségeket.`,
      priority: revenue < plan.daily_revenue_target * 0.75 ? "CRITICAL" : "HIGH",
      sourceRoute: "/admin/vir/cockpit",
      actorName,
    }));
  }
  if (noShowRate > 5) {
    writes.push(upsertSignalAction({
      locationId,
      sourceRef: `no-show:${date}:${locationKey}`,
      title: "Magas no-show arány",
      description: `A no-show arány ${noShowRate.toFixed(1)}%. Ellenőrizd a megerősítési és visszahívási folyamatot.`,
      priority: noShowRate >= 10 ? "CRITICAL" : "HIGH",
      sourceRoute: "/appointments/calendar",
      actorName,
    }));
  }
  if (cancellationRate > 10) {
    writes.push(upsertSignalAction({
      locationId,
      sourceRef: `cancellation:${date}:${locationKey}`,
      title: "Magas lemondási arány",
      description: `A lemondási arány ${cancellationRate.toFixed(1)}%. Vizsgáld meg a lemondások okát és a felszabaduló időablakok újratöltését.`,
      priority: cancellationRate >= 20 ? "CRITICAL" : "HIGH",
      sourceRoute: "/appointments/calendar",
      actorName,
    }));
  }
  await Promise.all(writes);
  return { summary, plan };
}

router.get("/cockpit", async (req: AuthRequest, res: Response) => {
  try {
    await ensureActionCenterSchema();
    const today = new Date().toISOString().slice(0, 10);
    const date = dateValue((req.query as QueryParams)?.date, today);
    const locationId = getScopedLocationId(req, res);
    if (locationId === undefined) return;

    const { summary, plan } = await syncOperationalSignals(req, date, locationId);
    const actionResult = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status <> 'DONE')::int AS open_count,
         COUNT(*) FILTER (WHERE status <> 'DONE' AND priority='CRITICAL')::int AS critical_count,
         COUNT(*) FILTER (WHERE status <> 'DONE' AND priority='HIGH')::int AS high_count,
         COUNT(*) FILTER (WHERE status <> 'DONE' AND due_at IS NOT NULL AND due_at < now())::int AS overdue_count,
         COUNT(*) FILTER (WHERE status='WAITING_APPROVAL')::int AS approval_count
       FROM vir_action_items
       WHERE ($1::uuid IS NULL OR location_id=$1::uuid OR location_id IS NULL)`,
      [locationId]
    );
    const topActions = await pool.query(
      `SELECT id, location_id, source, source_ref, title, description, priority, status,
              assignee_name, due_at, source_route, evidence, requires_approval, created_at, updated_at
       FROM vir_action_items
       WHERE status <> 'DONE' AND ($1::uuid IS NULL OR location_id=$1::uuid OR location_id IS NULL)
       ORDER BY
         CASE priority WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END,
         due_at ASC NULLS LAST, created_at DESC
       LIMIT 8`,
      [locationId]
    );
    const sourceHealth = await pool.query(
      `SELECT source,
              COUNT(*) FILTER (WHERE status <> 'DONE')::int AS open_count,
              COUNT(*) FILTER (WHERE status <> 'DONE' AND priority IN ('CRITICAL','HIGH'))::int AS urgent_count
       FROM vir_action_items
       WHERE ($1::uuid IS NULL OR location_id=$1::uuid OR location_id IS NULL)
       GROUP BY source
       ORDER BY urgent_count DESC, open_count DESC, source`,
      [locationId]
    );

    const revenue = Number(summary.revenue_total || 0);
    const target = Number(plan.daily_revenue_target || 0);
    const targetPercent = target > 0 ? Number(((revenue / target) * 100).toFixed(1)) : null;
    return res.json({
      ok: true,
      date,
      location_id: locationId,
      kpis: {
        revenue_total: revenue,
        paid_total: Number(summary.paid_total || 0),
        appointments_count: Number(summary.appointments_count || 0),
        completed_count: Number(summary.completed_count || 0),
        cancelled_count: Number(summary.cancelled_count || 0),
        no_show_count: Number(summary.no_show_count || 0),
        avg_basket: Number(summary.avg_basket || 0),
        cancellation_rate_percent: Number(summary.cancellation_rate_percent || 0),
        no_show_rate_percent: Number(summary.no_show_rate_percent || 0),
        daily_revenue_target: target,
        revenue_target_percent: targetPercent,
        scheduled_hours: Number(plan.scheduled_hours || 0),
      },
      actions: actionResult.rows[0] || { open_count: 0, critical_count: 0, high_count: 0, overdue_count: 0, approval_count: 0 },
      top_actions: topActions.rows,
      source_health: sourceHealth.rows,
    });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || "vir_manager_cockpit_failed" });
  }
});

router.get("/actions", async (req: AuthRequest, res: Response) => {
  try {
    await ensureActionCenterSchema();
    const today = new Date().toISOString().slice(0, 10);
    const date = dateValue((req.query as QueryParams)?.date, today);
    const locationId = getScopedLocationId(req, res);
    if (locationId === undefined) return;
    await syncOperationalSignals(req, date, locationId);

    const statusRaw = String((req.query as QueryParams)?.status || "").toUpperCase();
    const priorityRaw = String((req.query as QueryParams)?.priority || "").toUpperCase();
    const source = String((req.query as QueryParams)?.source || "").trim();
    const limit = positiveLimit((req.query as QueryParams)?.limit);
    const status = STATUSES.has(statusRaw as ActionStatus) ? statusRaw : null;
    const priority = PRIORITIES.has(priorityRaw as Priority) ? priorityRaw : null;

    const { rows } = await pool.query(
      `SELECT id, location_id, source, source_ref, title, description, priority, status,
              assignee_name, due_at, source_route, evidence, requires_approval,
              created_by, created_at, updated_by, updated_at, completed_at
       FROM vir_action_items
       WHERE ($1::uuid IS NULL OR location_id=$1::uuid OR location_id IS NULL)
         AND ($2::text IS NULL OR status=$2)
         AND ($3::text IS NULL OR priority=$3)
         AND ($4::text='' OR source=$4)
       ORDER BY
         CASE WHEN status='DONE' THEN 2 ELSE 1 END,
         CASE priority WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END,
         due_at ASC NULLS LAST, updated_at DESC
       LIMIT $5::integer`,
      [locationId, status, priority, source, limit]
    );
    return res.json({ ok: true, rows });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || "vir_action_center_failed" });
  }
});

router.post("/actions", async (req: AuthRequest, res: Response) => {
  try {
    await ensureActionCenterSchema();
    const locationId = String(req.body?.location_id || req.body?.locationId || "").trim() || null;
    const title = String(req.body?.title || "").trim();
    if (!title) return res.status(400).json({ ok: false, error: "A feladat címe kötelező." });
    const id = crypto.randomUUID();
    const priority = cleanPriority(req.body?.priority);
    const status = cleanStatus(req.body?.status);
    const source = String(req.body?.source || "MANUAL").trim().toUpperCase().slice(0, 64) || "MANUAL";
    const createdBy = actor(req);
    const { rows } = await pool.query(
      `INSERT INTO vir_action_items (
         id, location_id, source, source_ref, title, description, priority, status,
         assignee_name, due_at, source_route, evidence, requires_approval, created_by, updated_by
       ) VALUES ($1::uuid,$2::uuid,$3,NULL,$4,$5,$6,$7,$8,$9::timestamptz,$10,$11,$12,$13,$13)
       RETURNING *`,
      [
        id,
        locationId,
        source,
        title,
        String(req.body?.description || "").trim(),
        priority,
        status,
        String(req.body?.assignee_name || "").trim() || null,
        req.body?.due_at || null,
        String(req.body?.source_route || "").trim() || null,
        String(req.body?.evidence || "").trim() || null,
        Boolean(req.body?.requires_approval),
        createdBy,
      ]
    );
    return res.status(201).json({ ok: true, item: rows[0] });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || "vir_action_create_failed" });
  }
});

router.patch("/actions/:id", async (req: AuthRequest, res: Response) => {
  try {
    await ensureActionCenterSchema();
    const id = String(req.params.id || "").trim();
    const existing = await pool.query(`SELECT * FROM vir_action_items WHERE id=$1::uuid`, [id]);
    if (!existing.rows[0]) return res.status(404).json({ ok: false, error: "A feladat nem található." });
    const current = existing.rows[0];
    const priority = req.body?.priority === undefined ? current.priority : cleanPriority(req.body.priority, current.priority);
    const status = req.body?.status === undefined ? current.status : cleanStatus(req.body.status, current.status);
    const completedAt = status === "DONE" ? current.completed_at || new Date() : null;
    const { rows } = await pool.query(
      `UPDATE vir_action_items SET
         title=$2,
         description=$3,
         priority=$4,
         status=$5,
         assignee_name=$6,
         due_at=$7::timestamptz,
         source_route=$8,
         evidence=$9,
         requires_approval=$10,
         updated_by=$11,
         updated_at=now(),
         completed_at=$12::timestamptz
       WHERE id=$1::uuid
       RETURNING *`,
      [
        id,
        req.body?.title === undefined ? current.title : String(req.body.title).trim() || current.title,
        req.body?.description === undefined ? current.description : String(req.body.description || "").trim(),
        priority,
        status,
        req.body?.assignee_name === undefined ? current.assignee_name : String(req.body.assignee_name || "").trim() || null,
        req.body?.due_at === undefined ? current.due_at : req.body.due_at || null,
        req.body?.source_route === undefined ? current.source_route : String(req.body.source_route || "").trim() || null,
        req.body?.evidence === undefined ? current.evidence : String(req.body.evidence || "").trim() || null,
        req.body?.requires_approval === undefined ? current.requires_approval : Boolean(req.body.requires_approval),
        actor(req),
        completedAt,
      ]
    );
    return res.json({ ok: true, item: rows[0] });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || "vir_action_update_failed" });
  }
});

export default router;
