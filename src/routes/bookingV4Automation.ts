import { Router } from "express";
import db from "../db";
import type { AuthRequest } from "../middleware/auth";
import bookingV4AutopilotRouter from "./bookingV4Autopilot";

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEDUPE_RE = /^[a-zA-Z0-9:_@./|+-]{1,180}$/;
const MODES = new Set(["advisory", "assisted"]);
const QUEUE_STATUSES = new Set(["prepared", "approved", "cancelled"]);
let schemaReady: Promise<void> | null = null;

function uuid(value: unknown) {
  const text = String(value || "").trim();
  return UUID_RE.test(text) ? text : null;
}
function bounded(value: unknown, min: number, max: number, fallback: number) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function actor(req: AuthRequest) {
  return req.user?.email || String(req.user?.id || "management");
}
function bool(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}
function requireValidOptionalUuid(value: unknown, field: string) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const parsed = uuid(raw);
  if (!parsed) throw Object.assign(new Error(`${field}: érvénytelen UUID.`), { status: 400 });
  return parsed;
}

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = db.query(`
      CREATE TABLE IF NOT EXISTS booking_automation_policy (
        scope_key text PRIMARY KEY,
        location_id uuid REFERENCES locations(id) ON DELETE CASCADE,
        mode text NOT NULL DEFAULT 'advisory' CHECK (mode IN ('advisory','assisted')),
        no_show_threshold int NOT NULL DEFAULT 55 CHECK (no_show_threshold BETWEEN 0 AND 100),
        deposit_percent numeric(5,2) NOT NULL DEFAULT 20 CHECK (deposit_percent BETWEEN 0 AND 100),
        waitlist_first boolean NOT NULL DEFAULT true,
        rebooking_enabled boolean NOT NULL DEFAULT true,
        reminder_medium_risk boolean NOT NULL DEFAULT true,
        updated_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK ((scope_key='*' AND location_id IS NULL) OR (scope_key<>'*' AND location_id IS NOT NULL))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_automation_policy_location
        ON booking_automation_policy(location_id) WHERE location_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS booking_automation_queue (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        dedupe_key text NOT NULL UNIQUE,
        action_type text NOT NULL,
        entity_type text NOT NULL,
        entity_id uuid,
        location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
        status text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','approved','cancelled')),
        priority int NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        available_at timestamptz NOT NULL DEFAULT now(),
        created_by text,
        updated_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_booking_automation_queue_work
        ON booking_automation_queue(status, priority DESC, available_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_booking_automation_queue_location
        ON booking_automation_queue(location_id, status, created_at DESC);
      CREATE TABLE IF NOT EXISTS booking_automation_audit (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        event_type text NOT NULL,
        queue_id uuid REFERENCES booking_automation_queue(id) ON DELETE SET NULL,
        location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
        actor_key text,
        before_data jsonb,
        after_data jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO booking_automation_policy(scope_key, location_id, mode)
      VALUES('*', NULL, 'advisory') ON CONFLICT(scope_key) DO NOTHING;
    `).then(() => undefined).catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

router.use(async (_req, res, next) => {
  try {
    await ensureSchema();
    next();
  } catch (error: any) {
    res.status(500).json({ error: "A Booking Automation adatmodell inicializálása sikertelen.", detail: error?.message || String(error) });
  }
});

router.use("/autopilot", bookingV4AutopilotRouter);

router.get("/policy", async (req: AuthRequest, res) => {
  try {
    const locationId = requireValidOptionalUuid(req.query.location_id, "location_id");
    const exact = locationId
      ? (await db.query(`SELECT * FROM booking_automation_policy WHERE location_id=$1::uuid LIMIT 1`, [locationId])).rows[0]
      : null;
    const global = (await db.query(`SELECT * FROM booking_automation_policy WHERE scope_key='*' LIMIT 1`)).rows[0];
    const policy = exact || global;
    res.json({ policy, inherited: Boolean(locationId && !exact), requested_location_id: locationId });
  } catch (error: any) {
    res.status(error?.status || 500).json({ error: error?.status ? error.message : "Az automatizálási szabályok nem tölthetők be.", detail: error?.status ? undefined : error?.message });
  }
});

router.put("/policy", async (req: AuthRequest, res) => {
  try {
    const locationId = requireValidOptionalUuid(req.body?.location_id, "location_id");
    const mode = String(req.body?.mode || "advisory").trim();
    if (!MODES.has(mode)) return res.status(400).json({ error: "Az üzemmód csak advisory vagy assisted lehet." });
    const noShowThreshold = Math.round(bounded(req.body?.no_show_threshold, 0, 100, 55));
    const depositPercent = bounded(req.body?.deposit_percent, 0, 100, 20);
    const waitlistFirst = bool(req.body?.waitlist_first, true);
    const rebookingEnabled = bool(req.body?.rebooking_enabled, true);
    const reminderMediumRisk = bool(req.body?.reminder_medium_risk, true);
    const scopeKey = locationId || "*";
    const who = actor(req);
    const before = (await db.query(`SELECT * FROM booking_automation_policy WHERE scope_key=$1`, [scopeKey])).rows[0] || null;
    const row = (await db.query(`
      INSERT INTO booking_automation_policy(scope_key,location_id,mode,no_show_threshold,deposit_percent,waitlist_first,rebooking_enabled,reminder_medium_risk,updated_by)
      VALUES($1,$2::uuid,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT(scope_key) DO UPDATE SET
        location_id=EXCLUDED.location_id,mode=EXCLUDED.mode,no_show_threshold=EXCLUDED.no_show_threshold,
        deposit_percent=EXCLUDED.deposit_percent,waitlist_first=EXCLUDED.waitlist_first,
        rebooking_enabled=EXCLUDED.rebooking_enabled,reminder_medium_risk=EXCLUDED.reminder_medium_risk,
        updated_by=EXCLUDED.updated_by,updated_at=now()
      RETURNING *
    `, [scopeKey, locationId, mode, noShowThreshold, depositPercent, waitlistFirst, rebookingEnabled, reminderMediumRisk, who])).rows[0];
    await db.query(`INSERT INTO booking_automation_audit(event_type,location_id,actor_key,before_data,after_data) VALUES('policy_updated',$1::uuid,$2,$3::jsonb,$4::jsonb)`, [locationId, who, JSON.stringify(before), JSON.stringify(row)]);
    res.json({ ok: true, policy: row });
  } catch (error: any) {
    res.status(error?.status || 500).json({ error: error?.status ? error.message : "Az automatizálási szabályok nem menthetők.", detail: error?.status ? undefined : error?.message });
  }
});

router.get("/queue", async (req: AuthRequest, res) => {
  try {
    const locationId = requireValidOptionalUuid(req.query.location_id, "location_id");
    const statusRaw = String(req.query.status || "").trim();
    if (statusRaw && !QUEUE_STATUSES.has(statusRaw)) return res.status(400).json({ error: "Érvénytelen queue státusz." });
    const limit = Math.round(bounded(req.query.limit, 1, 200, 80));
    const rows = (await db.query(`
      SELECT q.*, l.name location_name
      FROM booking_automation_queue q LEFT JOIN locations l ON l.id=q.location_id
      WHERE ($1::uuid IS NULL OR q.location_id=$1::uuid) AND ($2='' OR q.status=$2)
      ORDER BY CASE q.status WHEN 'prepared' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
               q.priority DESC, q.available_at, q.created_at DESC
      LIMIT $3
    `, [locationId, statusRaw, limit])).rows;
    const summary = (await db.query(`
      SELECT count(*)::int total,
        count(*) FILTER(WHERE status='prepared')::int prepared,
        count(*) FILTER(WHERE status='approved')::int approved,
        count(*) FILTER(WHERE status='cancelled')::int cancelled,
        count(*) FILTER(WHERE status='prepared' AND priority>=85)::int urgent
      FROM booking_automation_queue WHERE ($1::uuid IS NULL OR location_id=$1::uuid)
    `, [locationId])).rows[0];
    res.json({ queue: rows, summary });
  } catch (error: any) {
    res.status(error?.status || 500).json({ error: error?.status ? error.message : "Az automatizálási queue nem tölthető be.", detail: error?.status ? undefined : error?.message });
  }
});

router.post("/queue/prepare", async (req: AuthRequest, res) => {
  const input = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!input.length || input.length > 100) return res.status(400).json({ error: "1–100 előkészítendő tétel szükséges." });
  const cx = await db.connect();
  try {
    await cx.query("BEGIN");
    const who = actor(req);
    const result: any[] = [];
    let created = 0;
    let existing = 0;
    for (const raw of input) {
      const dedupeKey = String(raw?.dedupe_key || "").trim();
      const actionType = String(raw?.action_type || "").trim().slice(0, 80);
      const entityType = String(raw?.entity_type || "").trim().slice(0, 80);
      const entityId = requireValidOptionalUuid(raw?.entity_id, "entity_id");
      const locationId = requireValidOptionalUuid(raw?.location_id, "location_id");
      if (!DEDUPE_RE.test(dedupeKey)) throw Object.assign(new Error("A dedupe_key 1–180 biztonságos karakterből állhat."), { status: 400 });
      if (!actionType || !entityType) throw Object.assign(new Error("action_type és entity_type szükséges."), { status: 400 });
      const priority = Math.round(bounded(raw?.priority, 0, 100, 50));
      const payload = raw?.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload) ? raw.payload : {};
      const availableAt = raw?.available_at ? new Date(raw.available_at) : new Date();
      if (Number.isNaN(availableAt.getTime())) throw Object.assign(new Error("Érvénytelen available_at."), { status: 400 });
      const inserted = (await cx.query(`
        INSERT INTO booking_automation_queue(dedupe_key,action_type,entity_type,entity_id,location_id,status,priority,payload,available_at,created_by,updated_by)
        VALUES($1,$2,$3,$4::uuid,$5::uuid,'prepared',$6,$7::jsonb,$8,$9,$9)
        ON CONFLICT(dedupe_key) DO NOTHING RETURNING *
      `, [dedupeKey, actionType, entityType, entityId, locationId, priority, JSON.stringify(payload), availableAt.toISOString(), who])).rows[0];
      if (inserted) {
        created += 1;
        result.push(inserted);
        await cx.query(`INSERT INTO booking_automation_audit(event_type,queue_id,location_id,actor_key,after_data) VALUES('queue_prepared',$1::uuid,$2::uuid,$3,$4::jsonb)`, [inserted.id, locationId, who, JSON.stringify(inserted)]);
      } else {
        existing += 1;
        result.push((await cx.query(`SELECT * FROM booking_automation_queue WHERE dedupe_key=$1`, [dedupeKey])).rows[0]);
      }
    }
    await cx.query("COMMIT");
    res.status(created ? 201 : 200).json({ ok: true, created, existing, items: result });
  } catch (error: any) {
    await cx.query("ROLLBACK").catch(() => undefined);
    res.status(error?.status || 500).json({ error: error?.status ? error.message : "Az automatizálási tételek nem készíthetők elő.", detail: error?.status ? undefined : error?.message });
  } finally {
    cx.release();
  }
});

router.patch("/queue/:id", async (req: AuthRequest, res) => {
  const id = uuid(req.params.id);
  if (!id) return res.status(400).json({ error: "Érvénytelen queue azonosító." });
  const nextStatus = String(req.body?.status || "").trim();
  if (!QUEUE_STATUSES.has(nextStatus) || nextStatus === "prepared") return res.status(400).json({ error: "Csak approved vagy cancelled állapot választható." });
  const cx = await db.connect();
  try {
    await cx.query("BEGIN");
    const before = (await cx.query(`SELECT * FROM booking_automation_queue WHERE id=$1::uuid FOR UPDATE`, [id])).rows[0];
    if (!before) {
      await cx.query("ROLLBACK");
      return res.status(404).json({ error: "Queue tétel nem található." });
    }
    if (before.status === "cancelled") {
      await cx.query("ROLLBACK");
      return res.status(409).json({ error: "A törölt tétel nem aktiválható újra." });
    }
    if (before.status === "approved" && nextStatus === "approved") {
      await cx.query("ROLLBACK");
      return res.json({ ok: true, queue_item: before, unchanged: true });
    }
    const who = actor(req);
    const after = (await cx.query(`UPDATE booking_automation_queue SET status=$2,updated_by=$3,updated_at=now() WHERE id=$1::uuid RETURNING *`, [id, nextStatus, who])).rows[0];
    await cx.query(`INSERT INTO booking_automation_audit(event_type,queue_id,location_id,actor_key,before_data,after_data) VALUES($1,$2::uuid,$3::uuid,$4,$5::jsonb,$6::jsonb)`, [`queue_${nextStatus}`, id, after.location_id, who, JSON.stringify(before), JSON.stringify(after)]);
    await cx.query("COMMIT");
    res.json({ ok: true, queue_item: after });
  } catch (error: any) {
    await cx.query("ROLLBACK").catch(() => undefined);
    res.status(500).json({ error: "A queue állapota nem módosítható.", detail: error?.message || String(error) });
  } finally {
    cx.release();
  }
});

router.get("/audit", async (req: AuthRequest, res) => {
  try {
    const locationId = requireValidOptionalUuid(req.query.location_id, "location_id");
    const limit = Math.round(bounded(req.query.limit, 1, 100, 40));
    const rows = (await db.query(`SELECT * FROM booking_automation_audit WHERE ($1::uuid IS NULL OR location_id=$1::uuid) ORDER BY created_at DESC LIMIT $2`, [locationId, limit])).rows;
    res.json({ audit: rows });
  } catch (error: any) {
    res.status(error?.status || 500).json({ error: error?.status ? error.message : "Az automatizálási audit nem tölthető be.", detail: error?.status ? undefined : error?.message });
  }
});

export default router;