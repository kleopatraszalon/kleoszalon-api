import axios from "axios";
import db from "../db";
import ensureOnlineBooking from "./ensureOnlineBooking";

const TZ = "Europe/Budapest";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let schemaReady: Promise<void> | null = null;

type RiskResult = {
  client_id: string | null;
  visits: number;
  no_shows: number;
  cancellations: number;
  no_show_rate: number;
  score: number;
  level: "low" | "medium" | "high";
  reasons: string[];
};

type Policy = {
  mode: string;
  no_show_threshold: number;
  deposit_percent: number;
  waitlist_first: boolean;
  rebooking_enabled: boolean;
  reminder_medium_risk: boolean;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const n = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
const uuid = (value: unknown) => { const text = String(value || "").trim(); return UUID_RE.test(text) ? text : null; };
const dateOnly = (value: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
const addDays = (date: Date, days: number) => new Date(date.getTime() + days * 86_400_000);
const outputText = (data: any) => String(data?.output_text || data?.output?.flatMap((x: any) => x?.content || []).find((x: any) => x?.type === "output_text")?.text || "");

export async function ensureVirWave1Schema() {
  await ensureOnlineBooking();
  if (!schemaReady) {
    schemaReady = db.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE TABLE IF NOT EXISTS vir_autopilot_runs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
        horizon_days int NOT NULL DEFAULT 7,
        mode text NOT NULL DEFAULT 'advisory',
        summary jsonb NOT NULL DEFAULT '{}'::jsonb,
        generated_by text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS vir_autopilot_runs_location_time_idx ON vir_autopilot_runs(location_id,created_at DESC);

      CREATE TABLE IF NOT EXISTS booking_no_show_scores (
        client_id uuid PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
        score int NOT NULL CHECK(score BETWEEN 0 AND 100),
        risk_level text NOT NULL CHECK(risk_level IN('low','medium','high')),
        visits int NOT NULL DEFAULT 0,
        no_shows int NOT NULL DEFAULT 0,
        cancellations int NOT NULL DEFAULT 0,
        reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
        calculated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS booking_deposit_requirements (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        appointment_id uuid REFERENCES appointments(id) ON DELETE CASCADE,
        client_id uuid REFERENCES clients(id) ON DELETE SET NULL,
        location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
        risk_score int NOT NULL DEFAULT 0,
        deposit_percent numeric(5,2) NOT NULL DEFAULT 0,
        amount numeric(12,2) NOT NULL DEFAULT 0,
        currency text NOT NULL DEFAULT 'HUF',
        status text NOT NULL DEFAULT 'required' CHECK(status IN('required','paid','waived','expired','cancelled')),
        source text NOT NULL DEFAULT 'vir_wave1',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS booking_deposit_requirement_appointment_active_uq
        ON booking_deposit_requirements(appointment_id) WHERE appointment_id IS NOT NULL AND status IN('required','paid');

      CREATE TABLE IF NOT EXISTS booking_waitlist_matches (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id uuid REFERENCES vir_autopilot_runs(id) ON DELETE CASCADE,
        waitlist_id uuid NOT NULL REFERENCES booking_waitlist(id) ON DELETE CASCADE,
        employee_id uuid REFERENCES employees(id) ON DELETE SET NULL,
        location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
        gap_start timestamptz NOT NULL,
        gap_end timestamptz NOT NULL,
        match_score int NOT NULL CHECK(match_score BETWEEN 0 AND 100),
        estimated_value numeric(12,2) NOT NULL DEFAULT 0,
        status text NOT NULL DEFAULT 'suggested' CHECK(status IN('suggested','approved','dismissed','converted','expired')),
        reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS booking_waitlist_matches_run_idx ON booking_waitlist_matches(run_id,match_score DESC);
    `).then(() => undefined).catch((error) => { schemaReady = null; throw error; });
  }
  await schemaReady;
}

export async function loadAutomationPolicy(locationId: string | null): Promise<Policy> {
  const exact = locationId && UUID_RE.test(locationId)
    ? (await db.query(`SELECT * FROM booking_automation_policy WHERE location_id=$1::uuid LIMIT 1`, [locationId])).rows[0]
    : null;
  const global = (await db.query(`SELECT * FROM booking_automation_policy WHERE scope_key='*' LIMIT 1`)).rows[0] || {};
  const row = exact || global;
  return {
    mode: String(row.mode || "advisory"),
    no_show_threshold: clamp(Math.round(n(row.no_show_threshold) || 55), 0, 100),
    deposit_percent: clamp(n(row.deposit_percent) || 20, 0, 100),
    waitlist_first: row.waitlist_first !== false,
    rebooking_enabled: row.rebooking_enabled !== false,
    reminder_medium_risk: row.reminder_medium_risk !== false,
  };
}

export async function calculateClientNoShowRisk(clientId: string | null): Promise<RiskResult> {
  if (!clientId || !UUID_RE.test(clientId)) {
    return { client_id: null, visits: 0, no_shows: 0, cancellations: 0, no_show_rate: 0, score: 12, level: "low", reasons: ["Nincs korábbi azonosítható vendégtörténet."] };
  }
  const row = (await db.query(`
    SELECT
      COUNT(*) FILTER(WHERE start_time<now())::int visits,
      COUNT(*) FILTER(WHERE lower(COALESCE(status,'')) IN('no_show','no-show','noshow','nem_jelent_meg'))::int no_shows,
      COUNT(*) FILTER(WHERE lower(COALESCE(status,'')) IN('cancelled','canceled'))::int cancellations,
      MAX(start_time) FILTER(WHERE lower(COALESCE(status,'')) IN('no_show','no-show','noshow','nem_jelent_meg')) last_no_show
    FROM appointments WHERE client_id=$1::uuid
  `, [clientId])).rows[0] || {};
  const visits = Math.max(0, n(row.visits));
  const noShows = Math.max(0, n(row.no_shows));
  const cancellations = Math.max(0, n(row.cancellations));
  const noShowRate = visits ? noShows / visits : 0;
  const reasons: string[] = [];
  let score = 8;
  score += Math.min(55, noShowRate * 70);
  score += Math.min(20, cancellations * 4);
  if (visits <= 1) { score += 8; reasons.push("Kevés előzmény miatt magasabb a bizonytalanság."); }
  if (noShows > 0) reasons.push(`${noShows} korábbi no-show esemény.`);
  if (cancellations >= 2) reasons.push(`${cancellations} korábbi lemondás.`);
  if (row.last_no_show) {
    const days = Math.max(0, (Date.now() - new Date(row.last_no_show).getTime()) / 86_400_000);
    if (days <= 90) { score += 14; reasons.push("90 napon belüli no-show."); }
  }
  if (visits >= 8 && noShows === 0) { score -= 10; reasons.push("Stabil, no-show nélküli visszatérő vendég."); }
  const rounded = clamp(Math.round(score), 0, 100);
  const level: RiskResult["level"] = rounded >= 70 ? "high" : rounded >= 40 ? "medium" : "low";
  const result = { client_id: clientId, visits, no_shows: noShows, cancellations, no_show_rate: Math.round(noShowRate * 1000) / 10, score: rounded, level, reasons };
  await db.query(`
    INSERT INTO booking_no_show_scores(client_id,score,risk_level,visits,no_shows,cancellations,reasons,calculated_at)
    VALUES($1::uuid,$2,$3,$4,$5,$6,$7::jsonb,now())
    ON CONFLICT(client_id) DO UPDATE SET score=EXCLUDED.score,risk_level=EXCLUDED.risk_level,visits=EXCLUDED.visits,
      no_shows=EXCLUDED.no_shows,cancellations=EXCLUDED.cancellations,reasons=EXCLUDED.reasons,calculated_at=now()
  `, [clientId, result.score, result.level, visits, noShows, cancellations, JSON.stringify(reasons)]);
  return result;
}

export function dynamicDepositDecision(risk: RiskResult, policy: Policy, bookingValue: number) {
  const value = Math.max(0, bookingValue);
  if (risk.score < policy.no_show_threshold) return { required: false, percent: 0, amount: 0, reason: "A kockázati pontszám a küszöb alatt van." };
  const extra = risk.score >= 90 ? 20 : risk.score >= 75 ? 10 : 0;
  const percent = clamp(Math.round(policy.deposit_percent + extra), 0, 60);
  const amount = Math.ceil((value * percent / 100) / 100) * 100;
  return { required: amount > 0, percent, amount, reason: `${risk.score}/100 no-show kockázat alapján dinamikus előleg.` };
}

async function serviceEconomics(locationId: string) {
  const row = (await db.query(`
    SELECT COALESCE(AVG(COALESCE(s.promo_price,s.list_price,s.base_price,0) / GREATEST(COALESCE(s.duration_minutes,30),5)),0)::numeric price_per_minute
    FROM services s
    WHERE COALESCE(s.is_active,true)=true
      AND (NOT EXISTS(SELECT 1 FROM service_locations x WHERE x.service_id=s.id)
           OR EXISTS(SELECT 1 FROM service_locations x WHERE x.service_id=s.id AND x.location_id=$1::uuid))
  `, [locationId])).rows[0] || {};
  return Math.max(0, n(row.price_per_minute));
}

type Gap = { employee_id: string; employee_name: string; location_id: string; start: string; end: string; minutes: number; estimated_value: number; schedule_source: string };

export async function findCalendarGaps(locationId: string, horizonDays = 7): Promise<Gap[]> {
  if (!UUID_RE.test(locationId)) return [];
  const days = clamp(Math.round(horizonDays), 1, 31);
  const cfg = (await db.query(`SELECT * FROM online_booking_settings WHERE location_id=$1::uuid`, [locationId])).rows[0] || { opening_minute: 480, closing_minute: 1200 };
  const employees = (await db.query(`SELECT id::text,COALESCE(NULLIF(full_name,''),concat_ws(' ',last_name,first_name),'Munkatárs') full_name FROM employees WHERE COALESCE(active,true)=true AND (location_id=$1::uuid OR location_id IS NULL) ORDER BY full_name`, [locationId])).rows;
  const ppm = await serviceEconomics(locationId);
  const gaps: Gap[] = [];

  for (let offset = 0; offset < days; offset += 1) {
    const day = dateOnly(addDays(new Date(), offset));
    const bounds = (await db.query(`SELECT (($1::date+make_interval(mins=>$2::int)) AT TIME ZONE '${TZ}') starts_at,(($1::date+make_interval(mins=>$3::int)) AT TIME ZONE '${TZ}') ends_at`, [day, Number(cfg.opening_minute || 480), Number(cfg.closing_minute || 1200)])).rows[0];
    const salonFrom = new Date(bounds.starts_at), salonTo = new Date(bounds.ends_at);
    const ids = employees.map((e: any) => e.id);
    if (!ids.length) break;
    const hasShifts = Boolean((await db.query(`SELECT to_regclass('public.work_shifts') IS NOT NULL ok`)).rows[0]?.ok);
    let shiftRows: any[] = [];
    if (hasShifts) shiftRows = (await db.query(`SELECT employee_id::text,kleo_booking_utc(starts_at) starts_at,kleo_booking_utc(ends_at) ends_at FROM work_shifts WHERE work_date=$1::date AND status='published' AND employee_id=ANY($2::uuid[]) ORDER BY employee_id,starts_at`, [day, ids])).rows;
    const published = shiftRows.length > 0;
    const busy = (await db.query(`
      SELECT employee_id::text,kleo_booking_utc(start_time) start_time,kleo_booking_utc(end_time) end_time
        FROM appointments WHERE employee_id=ANY($1::uuid[]) AND start_time<$3::timestamptz AND end_time>$2::timestamptz
         AND lower(COALESCE(status,'')) NOT IN('cancelled','canceled','no_show','no-show')
      UNION ALL
      SELECT employee_id::text,kleo_booking_utc(start_time),kleo_booking_utc(end_time)
        FROM appointment_technical_breaks WHERE employee_id=ANY($1::uuid[]) AND start_time<$3::timestamptz AND end_time>$2::timestamptz
    `, [ids, salonFrom.toISOString(), salonTo.toISOString()])).rows;
    for (const employee of employees) {
      const intervals = published
        ? shiftRows.filter((x: any) => String(x.employee_id) === employee.id).map((x: any) => ({ from: new Date(x.starts_at), to: new Date(x.ends_at) }))
        : [{ from: salonFrom, to: salonTo }];
      const blocks = busy.filter((x: any) => String(x.employee_id) === employee.id).map((x: any) => ({ from: new Date(x.start_time), to: new Date(x.end_time) })).sort((a: any, b: any) => a.from.getTime() - b.from.getTime());
      for (const interval of intervals) {
        let cursor = interval.from > new Date() ? interval.from : new Date();
        for (const block of blocks) {
          if (block.to <= cursor || block.from >= interval.to) continue;
          if (block.from > cursor) {
            const minutes = Math.floor((block.from.getTime() - cursor.getTime()) / 60000);
            if (minutes >= 30) gaps.push({ employee_id: employee.id, employee_name: employee.full_name, location_id: locationId, start: cursor.toISOString(), end: block.from.toISOString(), minutes, estimated_value: Math.round(minutes * ppm), schedule_source: published ? "published_shifts" : "salon_hours_fallback" });
          }
          if (block.to > cursor) cursor = block.to;
        }
        if (interval.to > cursor) {
          const minutes = Math.floor((interval.to.getTime() - cursor.getTime()) / 60000);
          if (minutes >= 30) gaps.push({ employee_id: employee.id, employee_name: employee.full_name, location_id: locationId, start: cursor.toISOString(), end: interval.to.toISOString(), minutes, estimated_value: Math.round(minutes * ppm), schedule_source: published ? "published_shifts" : "salon_hours_fallback" });
        }
      }
    }
  }
  return gaps.sort((a, b) => b.estimated_value - a.estimated_value || a.start.localeCompare(b.start)).slice(0, 120);
}

async function waitlistCandidates(locationId: string) {
  return (await db.query(`SELECT w.*,COALESCE(c.id,w.client_id)::text resolved_client_id FROM booking_waitlist w LEFT JOIN clients c ON c.id=w.client_id WHERE w.location_id=$1::uuid AND lower(COALESCE(w.status,'waiting')) IN('waiting','active') ORDER BY w.created_at LIMIT 300`, [locationId])).rows;
}

export async function matchWaitlist(locationId: string, gaps: Gap[]) {
  const waiting = await waitlistCandidates(locationId);
  const matches: any[] = [];
  for (const gap of gaps) {
    const from = new Date(gap.start), to = new Date(gap.end);
    for (const item of waiting) {
      if (item.preferred_employee_id && String(item.preferred_employee_id) !== gap.employee_id) continue;
      if (item.preferred_from && new Date(item.preferred_from) > to) continue;
      if (item.preferred_to && new Date(item.preferred_to) < from) continue;
      const serviceIds = Array.isArray(item.service_ids) ? item.service_ids.map(String) : [];
      if (!serviceIds.length) continue;
      const durationRow = (await db.query(`SELECT COALESCE(SUM(COALESCE(duration_minutes,30)),0)::int minutes,COALESCE(SUM(COALESCE(promo_price,list_price,base_price,0)),0)::numeric value FROM services WHERE id=ANY($1::uuid[]) AND COALESCE(is_active,true)=true`, [serviceIds])).rows[0] || {};
      const duration = n(durationRow.minutes), value = n(durationRow.value);
      if (duration <= 0 || duration > gap.minutes) continue;
      let score = 70;
      const reasons: string[] = ["A kért szolgáltatás belefér a felszabadult idősávba."];
      if (item.preferred_employee_id) { score += 15; reasons.push("A kívánt munkatárs egyezik."); }
      if (item.preferred_from || item.preferred_to) { score += 8; reasons.push("A kívánt időablak átfed a réssel."); }
      const ageHours = Math.max(0, (Date.now() - new Date(item.created_at).getTime()) / 3_600_000);
      score += Math.min(7, Math.floor(ageHours / 24));
      matches.push({ waitlist_id: String(item.id), client_id: item.resolved_client_id ? String(item.resolved_client_id) : null, client_name: item.client_name, phone: item.phone || null, email: item.email || null, service_ids: serviceIds, employee_id: gap.employee_id, employee_name: gap.employee_name, location_id: locationId, gap_start: gap.start, gap_end: gap.end, service_minutes: duration, match_score: clamp(score, 0, 100), estimated_value: Math.round(value), reasons });
    }
  }
  const bestByWaitlist = new Map<string, any>();
  for (const match of matches.sort((a, b) => b.match_score - a.match_score || b.estimated_value - a.estimated_value)) if (!bestByWaitlist.has(match.waitlist_id)) bestByWaitlist.set(match.waitlist_id, match);
  return Array.from(bestByWaitlist.values()).slice(0, 80);
}

export async function rebookingCandidates(locationId: string, limit = 80) {
  const rows = (await db.query(`
    WITH completed AS (
      SELECT a.client_id,a.location_id,a.start_time,
             lag(a.start_time) OVER(PARTITION BY a.client_id ORDER BY a.start_time) prev_time
      FROM appointments a
      WHERE a.client_id IS NOT NULL AND a.location_id=$1::uuid
        AND a.start_time<now() AND lower(COALESCE(a.status,'')) IN('completed','paid','confirmed','booked')
    ), stats AS (
      SELECT client_id,count(*)::int visits,max(start_time) last_visit,
        COALESCE(avg(EXTRACT(EPOCH FROM(start_time-prev_time))/86400) FILTER(WHERE prev_time IS NOT NULL),35)::numeric avg_gap_days
      FROM completed GROUP BY client_id
    )
    SELECT s.client_id::text,c.full_name,c.name,c.email,c.phone,s.visits,s.last_visit,s.avg_gap_days,
      EXTRACT(EPOCH FROM(now()-s.last_visit))/86400 days_since,
      NOT EXISTS(SELECT 1 FROM appointments f WHERE f.client_id=s.client_id AND f.start_time>now() AND lower(COALESCE(f.status,'')) NOT IN('cancelled','canceled','no_show')) no_future
    FROM stats s JOIN clients c ON c.id=s.client_id
    WHERE NOT EXISTS(SELECT 1 FROM appointments f WHERE f.client_id=s.client_id AND f.start_time>now() AND lower(COALESCE(f.status,'')) NOT IN('cancelled','canceled','no_show'))
    ORDER BY (EXTRACT(EPOCH FROM(now()-s.last_visit))/86400 - s.avg_gap_days) DESC NULLS LAST
    LIMIT $2
  `, [locationId, clamp(Math.round(limit), 1, 300)])).rows;
  const candidates = rows.map((row: any) => {
    const cadence = clamp(Math.round(n(row.avg_gap_days) || 35), 14, 120);
    const since = Math.max(0, Math.round(n(row.days_since)));
    const overdue = Math.max(0, since - cadence);
    const churn = clamp(Math.round(20 + overdue * 2 + (since > cadence * 1.7 ? 20 : 0) - Math.min(15, n(row.visits))), 0, 100);
    const action = churn >= 70 ? "churn_rescue" : "rebook_outreach";
    return { client_id: String(row.client_id), client_name: row.full_name || row.name || "Vendég", email: row.email || null, phone: row.phone || null, visits: n(row.visits), last_visit: row.last_visit, cadence_days: cadence, days_since_last_visit: since, overdue_days: overdue, churn_score: churn, action, priority: clamp(45 + churn / 2, 0, 100), reason: overdue > 0 ? `A vendég a saját kb. ${cadence} napos ritmusához képest ${overdue} napja esedékes.` : `A vendég kb. ${cadence} napos visszatérési ritmusához közelít.` };
  }).filter((x: any) => x.overdue_days >= 3 || x.churn_score >= 55);
  return enhanceRebookingWithAi(candidates.slice(0, limit));
}

async function enhanceRebookingWithAi(candidates: any[]) {
  const key = String(process.env.OPENAI_API_KEY || "").trim();
  if (!key || !candidates.length) return { candidates, ai_used: false, ai_status: "not_configured" };
  const input = candidates.slice(0, 20).map((x: any) => ({ client_id: x.client_id, visits: x.visits, cadence_days: x.cadence_days, days_since_last_visit: x.days_since_last_visit, overdue_days: x.overdue_days, churn_score: x.churn_score, action: x.action }));
  try {
    const response = await axios.post("https://api.openai.com/v1/responses", {
      model: process.env.VIR_AUTOPILOT_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini",
      store: false,
      max_output_tokens: 800,
      text: { format: { type: "json_schema", name: "vir_rebooking", strict: true, schema: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { client_id: { type: "string" }, reason: { type: "string" }, suggested_message: { type: "string" } }, required: ["client_id","reason","suggested_message"], additionalProperties: false } } }, required: ["items"], additionalProperties: false } } },
      input: [{ role: "system", content: [{ type: "input_text", text: "Magyar szépségszalon visszafoglalási asszisztens vagy. Csak a kapott számokból dolgozz. Ne találj ki egészségügyi, személyes vagy szolgáltatási tényt. A reason max. 140, a suggested_message max. 220 karakter. Ne alkalmazz manipulatív vagy sürgető nyelvezetet." }] }, { role: "user", content: [{ type: "input_text", text: JSON.stringify({ candidates: input }) }] }],
    }, { headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, timeout: 12_000 });
    const parsed = JSON.parse(outputText(response.data).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    const map = new Map((Array.isArray(parsed?.items) ? parsed.items : []).map((x: any) => [String(x.client_id), x]));
    return { candidates: candidates.map((x: any) => { const ai: any = map.get(x.client_id); return ai ? { ...x, ai_reason: String(ai.reason || "").slice(0, 140), suggested_message: String(ai.suggested_message || "").slice(0, 220) } : x; }), ai_used: true, ai_status: "success" };
  } catch (error: any) {
    console.warn("[vir-wave1] rebooking AI fallback", error?.response?.status || error?.message || error);
    return { candidates, ai_used: false, ai_status: "fallback" };
  }
}

export async function upcomingRiskCandidates(locationId: string, days = 14) {
  const rows = (await db.query(`
    SELECT DISTINCT a.client_id::text client_id,COALESCE(c.full_name,c.name,'Vendég') client_name,c.email,c.phone
    FROM appointments a JOIN clients c ON c.id=a.client_id
    WHERE a.location_id=$1::uuid AND a.start_time BETWEEN now() AND now()+($2::text||' days')::interval
      AND lower(COALESCE(a.status,'')) NOT IN('cancelled','canceled','no_show')
    ORDER BY client_name LIMIT 200
  `, [locationId, clamp(Math.round(days), 1, 60)])).rows;
  const policy = await loadAutomationPolicy(locationId);
  const result: any[] = [];
  for (const row of rows) {
    const risk = await calculateClientNoShowRisk(String(row.client_id));
    if (risk.score < Math.max(25, policy.no_show_threshold - 20)) continue;
    result.push({ ...row, ...risk, deposit: dynamicDepositDecision(risk, policy, 0) });
  }
  return result.sort((a, b) => b.score - a.score).slice(0, 80);
}

export async function buildWave1Preview(locationId: string, horizonDays = 7, generatedBy = "management") {
  await ensureVirWave1Schema();
  const policy = await loadAutomationPolicy(locationId);
  const gaps = await findCalendarGaps(locationId, horizonDays);
  const waitlistMatches = policy.waitlist_first ? await matchWaitlist(locationId, gaps) : [];
  const riskCandidates = await upcomingRiskCandidates(locationId, Math.max(14, horizonDays));
  const rebooking = policy.rebooking_enabled ? await rebookingCandidates(locationId, 80) : { candidates: [], ai_used: false, ai_status: "disabled" };
  const recoveredValue = waitlistMatches.reduce((sum: number, x: any) => sum + n(x.estimated_value), 0);
  const openGapValue = gaps.reduce((sum, x) => sum + x.estimated_value, 0);
  const summary = {
    gaps: gaps.length,
    gap_minutes: gaps.reduce((sum, x) => sum + x.minutes, 0),
    estimated_open_capacity_value: Math.round(openGapValue),
    waitlist_matches: waitlistMatches.length,
    estimated_waitlist_recoverable_value: Math.round(recoveredValue),
    elevated_no_show_clients: riskCandidates.length,
    rebooking_candidates: rebooking.candidates.length,
    churn_high_risk: rebooking.candidates.filter((x: any) => x.churn_score >= 70).length,
    ai_used: rebooking.ai_used,
    ai_status: rebooking.ai_status,
  };
  const run = (await db.query(`INSERT INTO vir_autopilot_runs(location_id,horizon_days,mode,summary,generated_by) VALUES($1::uuid,$2,$3,$4::jsonb,$5) RETURNING id::text,created_at`, [locationId, horizonDays, policy.mode, JSON.stringify(summary), generatedBy])).rows[0];
  for (const match of waitlistMatches) await db.query(`INSERT INTO booking_waitlist_matches(run_id,waitlist_id,employee_id,location_id,gap_start,gap_end,match_score,estimated_value,reasons) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9::jsonb)`, [run.id, match.waitlist_id, match.employee_id, locationId, match.gap_start, match.gap_end, match.match_score, match.estimated_value, JSON.stringify(match.reasons)]);
  return { run, policy, summary, gaps, waitlist_matches: waitlistMatches, no_show: riskCandidates, rebooking };
}

export async function prepareWave1Actions(locationId: string, runId: string, actorKey: string) {
  await ensureVirWave1Schema();
  const run = (await db.query(`SELECT * FROM vir_autopilot_runs WHERE id=$1::uuid AND location_id=$2::uuid`, [runId, locationId])).rows[0];
  if (!run) throw Object.assign(new Error("Az Autopilot futás nem található."), { status: 404 });
  const matches = (await db.query(`SELECT * FROM booking_waitlist_matches WHERE run_id=$1::uuid AND status='suggested' ORDER BY match_score DESC LIMIT 100`, [runId])).rows;
  const rebooking = await rebookingCandidates(locationId, 60);
  const risk = await upcomingRiskCandidates(locationId, 14);
  const items: any[] = [];
  for (const m of matches) items.push({ dedupe_key: `wave1:${runId}:waitlist:${m.waitlist_id}`, action_type: "fill_gap_waitlist", entity_type: "booking_waitlist", entity_id: m.waitlist_id, location_id: locationId, priority: clamp(n(m.match_score), 0, 100), payload: { run_id: runId, employee_id: m.employee_id, gap_start: m.gap_start, gap_end: m.gap_end, estimated_value: n(m.estimated_value), match_score: n(m.match_score) } });
  for (const c of rebooking.candidates) items.push({ dedupe_key: `wave1:${runId}:rebook:${c.client_id}`, action_type: c.action, entity_type: "client", entity_id: c.client_id, location_id: locationId, priority: clamp(Math.round(n(c.priority)), 0, 100), payload: { run_id: runId, cadence_days: c.cadence_days, overdue_days: c.overdue_days, churn_score: c.churn_score, ai_reason: c.ai_reason || null, suggested_message: c.suggested_message || null } });
  for (const c of risk) if (c.score >= 70) items.push({ dedupe_key: `wave1:${runId}:risk:${c.client_id}`, action_type: "deposit_review", entity_type: "client", entity_id: c.client_id, location_id: locationId, priority: c.score, payload: { run_id: runId, no_show_score: c.score, risk_level: c.level, reasons: c.reasons } });
  const cx = await db.connect();
  try {
    await cx.query("BEGIN");
    let created = 0;
    for (const item of items.slice(0, 200)) {
      const inserted = (await cx.query(`INSERT INTO booking_automation_queue(dedupe_key,action_type,entity_type,entity_id,location_id,status,priority,payload,available_at,created_by,updated_by) VALUES($1,$2,$3,$4::uuid,$5::uuid,'prepared',$6,$7::jsonb,now(),$8,$8) ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`, [item.dedupe_key, item.action_type, item.entity_type, item.entity_id, item.location_id, item.priority, JSON.stringify(item.payload), actorKey])).rows[0];
      if (inserted) created += 1;
    }
    await cx.query("COMMIT");
    return { created, total_candidates: items.length };
  } catch (error) {
    await cx.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { cx.release(); }
}

export function bookingValueFromServices(rows: any[]) {
  return rows.reduce((sum, row) => sum + Math.max(0, n(row.price)), 0);
}

export async function resolveClientByContact(locationId: string, phone: string, email: string) {
  if (!UUID_RE.test(locationId) || (!phone && !email)) return null;
  const row = (await db.query(`SELECT id::text FROM clients WHERE location_id=$1::uuid AND (($2<>'' AND regexp_replace(COALESCE(phone,''),'[^0-9]','','g')=regexp_replace($2,'[^0-9]','','g')) OR ($3<>'' AND lower(COALESCE(email,''))=lower($3))) ORDER BY updated_at DESC NULLS LAST LIMIT 1`, [locationId, phone, email])).rows[0];
  return row?.id ? String(row.id) : null;
}

export async function createDepositRequirement(appointmentId: string, clientId: string | null, locationId: string, riskScore: number, percent: number, amount: number) {
  if (!UUID_RE.test(appointmentId) || !UUID_RE.test(locationId) || amount <= 0 || percent <= 0) return null;
  return (await db.query(`INSERT INTO booking_deposit_requirements(appointment_id,client_id,location_id,risk_score,deposit_percent,amount,status) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,'required') ON CONFLICT DO NOTHING RETURNING id::text,status,amount::numeric,deposit_percent::numeric`, [appointmentId, clientId && UUID_RE.test(clientId) ? clientId : null, locationId, clamp(Math.round(riskScore),0,100), clamp(percent,0,100), Math.max(0,amount)])).rows[0] || null;
}
