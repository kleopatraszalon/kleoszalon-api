import { Router } from "express";
import type { AuthRequest } from "../middleware/auth";
import db from "../db";
import virWave2Router from "./virWave2";
import {
  buildWave1Preview,
  calculateClientNoShowRisk,
  dynamicDepositDecision,
  ensureVirWave1Schema,
  loadAutomationPolicy,
  prepareWave1Actions,
} from "../booking/virWave1Engine";

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuid = (value: unknown) => { const text = String(value || "").trim(); return UUID_RE.test(text) ? text : null; };
const actor = (req: AuthRequest) => req.user?.email || String(req.user?.id || "management");

// VIR II. hullám külön bootstrapot használ, ezért a Wave I sémamiddleware előtt fut.
router.use("/wave2", virWave2Router);

router.use(async (_req, res, next) => {
  try { await ensureVirWave1Schema(); next(); }
  catch (error: any) { res.status(500).json({ error: "A VIR Autopilot I. hullám inicializálása sikertelen.", detail: error?.message || String(error) }); }
});

router.get("/preview", async (req: AuthRequest, res) => {
  const locationId = uuid(req.query.location_id);
  if (!locationId) return res.status(400).json({ error: "Érvényes location_id szükséges." });
  const days = Math.max(1, Math.min(31, Math.round(Number(req.query.days || 7)) || 7));
  try {
    const preview = await buildWave1Preview(locationId, days, actor(req));
    res.json({ wave: 1, name: "VIR Autopilot", generated_at: new Date().toISOString(), ...preview });
  } catch (error: any) {
    res.status(500).json({ error: "Az Autopilot előnézet nem készíthető el.", detail: error?.message || String(error) });
  }
});

router.post("/prepare", async (req: AuthRequest, res) => {
  const locationId = uuid(req.body?.location_id), runId = uuid(req.body?.run_id);
  if (!locationId || !runId) return res.status(400).json({ error: "location_id és run_id szükséges." });
  try {
    const result = await prepareWave1Actions(locationId, runId, actor(req));
    res.status(result.created ? 201 : 200).json({ ok: true, run_id: runId, ...result });
  } catch (error: any) {
    res.status(error?.status || 500).json({ error: error?.status ? error.message : "Az Autopilot akciók nem készíthetők elő.", detail: error?.status ? undefined : error?.message });
  }
});

router.post("/approve-all", async (req: AuthRequest, res) => {
  const locationId = uuid(req.body?.location_id), runId = uuid(req.body?.run_id);
  if (!locationId || !runId) return res.status(400).json({ error: "location_id és run_id szükséges." });
  try {
    const who = actor(req);
    const { rows } = await db.query(`
      UPDATE booking_automation_queue
         SET status='approved',updated_by=$3,updated_at=now()
       WHERE location_id=$1::uuid AND status='prepared' AND payload->>'run_id'=$2
       RETURNING id::text,action_type,entity_type,entity_id::text,priority,payload
    `, [locationId, runId, who]);
    for (const row of rows) {
      await db.query(`INSERT INTO booking_automation_audit(event_type,queue_id,location_id,actor_key,after_data) VALUES('wave1_bulk_approved',$1::uuid,$2::uuid,$3,$4::jsonb)`, [row.id, locationId, who, JSON.stringify(row)]);
    }
    res.json({ ok: true, approved: rows.length, items: rows });
  } catch (error: any) {
    res.status(500).json({ error: "Az Autopilot javaslatok tömeges jóváhagyása sikertelen.", detail: error?.message || String(error) });
  }
});

router.get("/risk/:clientId", async (req: AuthRequest, res) => {
  const clientId = uuid(req.params.clientId);
  if (!clientId) return res.status(400).json({ error: "Érvénytelen vendégazonosító." });
  try {
    const risk = await calculateClientNoShowRisk(clientId);
    const locationId = uuid(req.query.location_id);
    const policy = await loadAutomationPolicy(locationId);
    const bookingValue = Math.max(0, Number(req.query.booking_value || 0) || 0);
    res.json({ risk, deposit: dynamicDepositDecision(risk, policy, bookingValue), policy: { mode: policy.mode, no_show_threshold: policy.no_show_threshold, deposit_percent: policy.deposit_percent } });
  } catch (error: any) {
    res.status(500).json({ error: "A no-show kockázat nem számítható ki.", detail: error?.message || String(error) });
  }
});

router.get("/deposits", async (req: AuthRequest, res) => {
  const locationId = uuid(req.query.location_id);
  const status = String(req.query.status || "").trim();
  try {
    const { rows } = await db.query(`
      SELECT d.*,COALESCE(c.full_name,c.name,'Vendég') client_name,a.start_time,a.title
      FROM booking_deposit_requirements d
      LEFT JOIN clients c ON c.id=d.client_id
      LEFT JOIN appointments a ON a.id=d.appointment_id
      WHERE ($1::uuid IS NULL OR d.location_id=$1::uuid) AND ($2='' OR d.status=$2)
      ORDER BY d.created_at DESC LIMIT 200
    `, [locationId, status]);
    res.json({ deposits: rows });
  } catch (error: any) {
    res.status(500).json({ error: "Az előlegkövetelmények nem tölthetők be.", detail: error?.message || String(error) });
  }
});

router.patch("/deposits/:id", async (req: AuthRequest, res) => {
  const id = uuid(req.params.id);
  const status = String(req.body?.status || "").trim();
  if (!id || !["paid","waived","expired","cancelled"].includes(status)) return res.status(400).json({ error: "Érvénytelen azonosító vagy státusz." });
  try {
    const row = (await db.query(`UPDATE booking_deposit_requirements SET status=$2,updated_at=now() WHERE id=$1::uuid RETURNING *`, [id, status])).rows[0];
    if (!row) return res.status(404).json({ error: "Az előlegkövetelmény nem található." });
    res.json({ ok: true, deposit: row });
  } catch (error: any) {
    res.status(500).json({ error: "Az előlegstátusz nem módosítható.", detail: error?.message || String(error) });
  }
});

export default router;