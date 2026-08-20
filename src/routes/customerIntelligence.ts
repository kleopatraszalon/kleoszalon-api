import { Router, Response, NextFunction } from "express";
import pool from "../db";
import { requireAuth } from "../middleware/auth";
import { requireTenantContext, TenantAuthRequest } from "../middleware/tenantContext";

const router = Router();
const MANAGEMENT_ROLES = new Set([
  "admin",
  "administrator",
  "rendszergazda",
  "superadmin",
  "super_admin",
  "manager",
  "vezető",
  "vezeto",
  "location_manager",
  "salon_manager",
  "szalonvezető",
  "szalonvezeto",
  "üzletvezető",
  "uzletvezeto",
]);
const ACTION_STATUSES = new Set(["accepted", "dismissed", "completed"]);
const ACTION_CODES = new Set([
  "FIRST_VISIT",
  "WIN_BACK_60",
  "REBOOK_30",
  "NO_SHOW_PROTECTION",
  "VIP_RETENTION",
  "BIRTHDAY_OFFER",
  "CONSENT_REFRESH",
  "UPCOMING_CONFIRMATION",
  "CROSS_SELL",
  "RELATIONSHIP_MAINTENANCE",
]);

type IntelligenceRow = {
  client_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  birth_date: string | null;
  marketing_consent: boolean;
  email_consent: boolean;
  sms_consent: boolean;
  phone_consent: boolean;
  visits: number;
  no_shows: number;
  last_visit: string | null;
  next_visit: string | null;
  lifetime_value: number;
  preferred_contact: string | null;
};

type Recommendation = IntelligenceRow & {
  recency_days: number | null;
  value_tier: "new" | "standard" | "loyal" | "vip";
  risk_level: "low" | "medium" | "high";
  action_code: string;
  action_title: string;
  action_reason: string;
  priority: number;
  suggested_channel: "email" | "sms" | "phone" | "in_app" | "none";
  marketing_allowed: boolean;
};

function roleList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).map((x) => x.toLowerCase());
  const text = String(raw ?? "");
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map(String).map((x) => x.toLowerCase());
  } catch {}
  return text
    .split(",")
    .map((x) => x.replace(/[\[\]"]/g, "").trim().toLowerCase())
    .filter(Boolean);
}

function requireManagement(req: TenantAuthRequest, res: Response, next: NextFunction) {
  if (!roleList(req.user?.role).some((role) => MANAGEMENT_ROLES.has(role))) {
    return res.status(403).json({ ok: false, code: "CUSTOMER_INTELLIGENCE_FORBIDDEN", error: "Ehhez a funkcióhoz vezetői jogosultság szükséges." });
  }
  return next();
}

function userLocation(req: TenantAuthRequest): string | null {
  const roles = roleList(req.user?.role);
  const global = roles.some((r) => ["admin", "administrator", "rendszergazda", "superadmin", "super_admin", "manager", "vezető", "vezeto"].includes(r));
  if (global) return String(req.query.location_id || "").trim() || null;
  return String(req.user?.location_id || "").trim() || null;
}

let schemaPromise: Promise<void> | null = null;
async function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = pool.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE TABLE IF NOT EXISTS crm_next_best_action_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id bigint NOT NULL,
        client_id text NOT NULL,
        action_code text NOT NULL,
        action_status text NOT NULL CHECK (action_status IN ('accepted','dismissed','completed')),
        channel text,
        recommendation_version text NOT NULL DEFAULT 'nba-v1',
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        actor text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS crm_nba_events_tenant_client_idx
        ON crm_next_best_action_events(tenant_id, client_id, created_at DESC);
    `).then(() => undefined).catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  await schemaPromise;
}

async function clientTenantCapability() {
  const { rows } = await pool.query(`
    SELECT EXISTS(
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='clients' AND column_name='tenant_id'
    ) AS has_tenant_id
  `);
  return Boolean(rows[0]?.has_tenant_id);
}

function daysSince(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor(ms / 86_400_000));
}

function birthdayWithinDays(value: string | null, horizon = 14): boolean {
  if (!value) return false;
  const birth = new Date(value);
  if (Number.isNaN(birth.getTime())) return false;
  const now = new Date();
  const thisYear = new Date(now.getFullYear(), birth.getMonth(), birth.getDate());
  const target = thisYear.getTime() < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    ? new Date(now.getFullYear() + 1, birth.getMonth(), birth.getDate())
    : thisYear;
  const diff = Math.ceil((target.getTime() - now.getTime()) / 86_400_000);
  return diff >= 0 && diff <= horizon;
}

function preferredChannel(row: IntelligenceRow, marketingRequired: boolean): Recommendation["suggested_channel"] {
  if (marketingRequired && !row.marketing_consent) return "none";
  const preferred = String(row.preferred_contact || "").toLowerCase();
  if ((preferred === "email" || preferred === "e-mail") && row.email && row.email_consent) return "email";
  if ((preferred === "sms" || preferred === "text") && row.phone && row.sms_consent) return "sms";
  if ((preferred === "phone" || preferred === "telefon") && row.phone && row.phone_consent) return "phone";
  if (row.email && row.email_consent) return "email";
  if (row.phone && row.sms_consent) return "sms";
  if (row.phone && row.phone_consent) return "phone";
  return marketingRequired ? "none" : "in_app";
}

function recommend(row: IntelligenceRow): Recommendation {
  const visits = Number(row.visits || 0);
  const noShows = Number(row.no_shows || 0);
  const value = Number(row.lifetime_value || 0);
  const recency = daysSince(row.last_visit);
  const next = row.next_visit ? new Date(row.next_visit) : null;
  const hoursToNext = next && Number.isFinite(next.getTime()) ? (next.getTime() - Date.now()) / 3_600_000 : null;
  const valueTier: Recommendation["value_tier"] = visits === 0 ? "new" : value >= 150000 || visits >= 12 ? "vip" : value >= 60000 || visits >= 6 ? "loyal" : "standard";
  let risk: Recommendation["risk_level"] = recency !== null && recency >= 90 ? "high" : recency !== null && recency >= 45 ? "medium" : "low";
  if (row.next_visit) risk = "low";

  let action_code = "RELATIONSHIP_MAINTENANCE";
  let action_title = "Kapcsolatápolás";
  let action_reason = "A vendég jelenleg nem igényel sürgős beavatkozást.";
  let priority = 25;
  let marketingRequired = false;

  if (visits === 0) {
    action_code = "FIRST_VISIT";
    action_title = "Első látogatás ösztönzése";
    action_reason = "A vendég még nem rendelkezik befejezett látogatással.";
    priority = 72;
    marketingRequired = true;
  }
  if (!row.next_visit && recency !== null && recency >= 60) {
    action_code = "WIN_BACK_60";
    action_title = "Visszahívó ajánlat";
    action_reason = `${recency} nap telt el az utolsó látogatás óta és nincs következő időpont.`;
    priority = Math.min(96, 78 + Math.floor((recency - 60) / 10));
    marketingRequired = true;
  } else if (!row.next_visit && recency !== null && recency >= 30) {
    action_code = "REBOOK_30";
    action_title = "Újrafoglalás javasolt";
    action_reason = `${recency} nap telt el az utolsó látogatás óta, következő foglalás nélkül.`;
    priority = 68;
    marketingRequired = true;
  }
  if (noShows >= 2 && !row.next_visit) {
    action_code = "NO_SHOW_PROTECTION";
    action_title = "No-show védelem / előleg";
    action_reason = `${noShows} no-show esemény miatt a következő foglalásnál megerősítés vagy előleg javasolt.`;
    priority = Math.max(priority, 88);
    marketingRequired = false;
  }
  if ((valueTier === "vip" || valueTier === "loyal") && !row.next_visit && (recency === null || recency >= 21) && noShows < 2) {
    action_code = "VIP_RETENTION";
    action_title = valueTier === "vip" ? "VIP megtartási akció" : "Törzsvendég megtartási akció";
    action_reason = `${visits} látogatás és kb. ${Math.round(value).toLocaleString("hu-HU")} Ft becsült ügyfélérték mellett nincs következő időpont.`;
    priority = Math.max(priority, valueTier === "vip" ? 90 : 76);
    marketingRequired = true;
  }
  if (birthdayWithinDays(row.birth_date, 14) && row.marketing_consent) {
    action_code = "BIRTHDAY_OFFER";
    action_title = "Születésnapi ajánlat";
    action_reason = "A vendég születésnapja 14 napon belül esedékes és marketing-hozzájárulása aktív.";
    priority = Math.max(priority, 84);
    marketingRequired = true;
  }
  if (!row.marketing_consent && visits > 0 && !row.next_visit && action_code !== "NO_SHOW_PROTECTION") {
    action_code = "CONSENT_REFRESH";
    action_title = "Kapcsolattartási hozzájárulás rendezése";
    action_reason = "Van ügyfélkapcsolat, de nincs aktív marketing-hozzájárulás; marketingküldés nem indítható.";
    priority = Math.max(priority, 64);
    marketingRequired = false;
  }
  if (hoursToNext !== null && hoursToNext >= 0 && hoursToNext <= 72) {
    action_code = "UPCOMING_CONFIRMATION";
    action_title = "Közelgő időpont megerősítése";
    action_reason = "A következő foglalás 72 órán belül esedékes.";
    priority = noShows > 0 ? 92 : 70;
    marketingRequired = false;
  } else if (action_code === "RELATIONSHIP_MAINTENANCE" && visits >= 3) {
    action_code = "CROSS_SELL";
    action_title = "Keresztértékesítési lehetőség";
    action_reason = "Aktív visszatérő vendég; kiegészítő szolgáltatás vagy csomag ajánlható.";
    priority = 48;
    marketingRequired = true;
  }

  const channel = preferredChannel(row, marketingRequired);
  if (marketingRequired && channel === "none") {
    action_reason += " Nincs megfelelő marketingcsatorna-hozzájárulás, ezért automatikus megkeresés nem javasolt.";
  }

  return {
    ...row,
    visits,
    no_shows: noShows,
    lifetime_value: value,
    recency_days: recency,
    value_tier: valueTier,
    risk_level: risk,
    action_code,
    action_title,
    action_reason,
    priority,
    suggested_channel: channel,
    marketing_allowed: !marketingRequired || channel !== "none",
  };
}

async function loadRows(req: TenantAuthRequest, clientId?: string): Promise<IntelligenceRow[]> {
  const tenantId = String(req.tenant!.id);
  const locationId = userLocation(req);
  const hasTenantId = await clientTenantCapability();
  if (!hasTenantId && String(req.tenant!.slug) !== "kleopatra") {
    const error: any = new Error("A clients tábla még nem tenant-szeparált ehhez a SaaS tenanthez.");
    error.status = 503;
    error.code = "CUSTOMER_INTELLIGENCE_TENANT_SCOPE_UNAVAILABLE";
    throw error;
  }
  if (!locationId && roleList(req.user?.role).some((r) => ["location_manager", "salon_manager", "szalonvezető", "szalonvezeto", "üzletvezető", "uzletvezeto"].includes(r))) {
    const error: any = new Error("A felhasználóhoz nincs telephely rendelve.");
    error.status = 403;
    error.code = "LOCATION_SCOPE_REQUIRED";
    throw error;
  }
  const limitRaw = Number(req.query.limit || 200);
  const limit = clientId ? 1 : Math.max(1, Math.min(Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 200, 500));
  const { rows } = await pool.query(`
    WITH client_base AS (
      SELECT
        c.id::text client_id,
        COALESCE(NULLIF(to_jsonb(c)->>'full_name',''),NULLIF(to_jsonb(c)->>'name',''),'Névtelen ügyfél') name,
        NULLIF(to_jsonb(c)->>'email','') email,
        NULLIF(to_jsonb(c)->>'phone','') phone,
        NULLIF(to_jsonb(c)->>'birth_date','') birth_date,
        COALESCE(NULLIF(to_jsonb(c)->>'preferred_contact',''),'phone') preferred_contact,
        COALESCE(NULLIF(to_jsonb(c)->>'marketing_consent','')::boolean,false) marketing_consent,
        COALESCE(NULLIF(to_jsonb(c)->>'email_consent','')::boolean,false) email_consent,
        COALESCE(NULLIF(to_jsonb(c)->>'sms_consent','')::boolean,false) sms_consent,
        COALESCE(NULLIF(to_jsonb(c)->>'phone_consent','')::boolean,false) phone_consent,
        COALESCE(NULLIF(to_jsonb(c)->>'altegio_spent','')::numeric,0) altegio_spent,
        COALESCE(NULLIF(to_jsonb(c)->>'altegio_visits','')::integer,0) altegio_visits,
        NULLIF(to_jsonb(c)->>'altegio_last_visit','')::timestamptz altegio_last_visit
      FROM clients c
      WHERE ($1::text IS NULL OR ${hasTenantId ? "(to_jsonb(c)->>'tenant_id')=$1::text" : "$1::text IS NOT NULL"})
        AND ($2::text IS NULL OR (to_jsonb(c)->>'location_id')=$2::text)
        AND ($3::text IS NULL OR c.id::text=$3::text)
        AND COALESCE(NULLIF(to_jsonb(c)->>'is_active','')::boolean,true)=true
    ), appt AS (
      SELECT a.client_id::text client_id,
        COUNT(*) FILTER (WHERE a.start_time<=now() AND a.status IN ('completed','paid','confirmed'))::int visits,
        COUNT(*) FILTER (WHERE a.status='no_show')::int no_shows,
        MAX(a.start_time) FILTER (WHERE a.start_time<=now() AND a.status NOT IN ('cancelled','no_show')) last_visit,
        MIN(a.start_time) FILTER (WHERE a.start_time>now() AND a.status NOT IN ('cancelled','no_show')) next_visit
      FROM appointments a JOIN client_base cb ON cb.client_id=a.client_id::text
      GROUP BY a.client_id::text
    ), revenue AS (
      SELECT a.client_id::text client_id,
        COALESCE(SUM(COALESCE(aps.price,0)) FILTER (WHERE a.start_time<=now() AND a.status IN ('completed','paid')),0)::numeric revenue
      FROM appointments a
      JOIN client_base cb ON cb.client_id=a.client_id::text
      LEFT JOIN appointment_services aps ON aps.appointment_id=a.id
      GROUP BY a.client_id::text
    )
    SELECT cb.client_id,cb.name,cb.email,cb.phone,cb.birth_date::text birth_date,
      cb.preferred_contact,cb.marketing_consent,cb.email_consent,cb.sms_consent,cb.phone_consent,
      GREATEST(cb.altegio_visits,COALESCE(a.visits,0))::int visits,
      COALESCE(a.no_shows,0)::int no_shows,
      GREATEST(cb.altegio_last_visit,a.last_visit)::text last_visit,
      a.next_visit::text next_visit,
      GREATEST(cb.altegio_spent,COALESCE(r.revenue,0))::numeric lifetime_value
    FROM client_base cb
    LEFT JOIN appt a ON a.client_id=cb.client_id
    LEFT JOIN revenue r ON r.client_id=cb.client_id
    ORDER BY GREATEST(cb.altegio_last_visit,a.last_visit) DESC NULLS LAST, cb.name
    LIMIT $4::integer
  `, [hasTenantId ? tenantId : tenantId, locationId, clientId || null, limit]);
  return rows.map((row: any) => ({
    ...row,
    marketing_consent: Boolean(row.marketing_consent),
    email_consent: Boolean(row.email_consent),
    sms_consent: Boolean(row.sms_consent),
    phone_consent: Boolean(row.phone_consent),
    visits: Number(row.visits || 0),
    no_shows: Number(row.no_shows || 0),
    lifetime_value: Number(row.lifetime_value || 0),
  }));
}

router.use(requireAuth, requireTenantContext, requireManagement);

router.get("/overview", async (req: TenantAuthRequest, res: Response) => {
  try {
    await ensureSchema();
    const recommendations = (await loadRows(req)).map(recommend).sort((a, b) => b.priority - a.priority || b.lifetime_value - a.lifetime_value);
    const summary = {
      clients: recommendations.length,
      high_priority: recommendations.filter((x) => x.priority >= 80).length,
      at_risk: recommendations.filter((x) => x.risk_level === "high").length,
      vip: recommendations.filter((x) => x.value_tier === "vip").length,
      without_next_booking: recommendations.filter((x) => !x.next_visit).length,
      marketing_blocked: recommendations.filter((x) => !x.marketing_allowed).length,
      potential_value: Math.round(recommendations.reduce((sum, x) => sum + x.lifetime_value, 0)),
    };
    const action_mix = Object.values(recommendations.reduce<Record<string, { action_code: string; title: string; count: number }>>((acc, item) => {
      const key = item.action_code;
      acc[key] ||= { action_code: key, title: item.action_title, count: 0 };
      acc[key].count += 1;
      return acc;
    }, {})).sort((a, b) => b.count - a.count);
    return res.json({ ok: true, engine: { version: "nba-v1", explainable: true, automatic_sending: false }, scope: { tenant_id: req.tenant!.id, tenant: req.tenant!.slug, location_id: userLocation(req) }, summary, action_mix, rows: recommendations });
  } catch (error: any) {
    console.error("[customer-intelligence] overview failed", error);
    return res.status(Number(error?.status || 500)).json({ ok: false, code: error?.code || "CUSTOMER_INTELLIGENCE_ERROR", error: error?.message || "A Customer Intelligence adatok nem tölthetők be." });
  }
});

router.get("/clients/:id", async (req: TenantAuthRequest, res: Response) => {
  try {
    await ensureSchema();
    const rows = await loadRows(req, String(req.params.id));
    if (!rows.length) return res.status(404).json({ ok: false, code: "CLIENT_NOT_FOUND", error: "A vendég nem található ebben a tenant/telephely scope-ban." });
    const recommendation = recommend(rows[0]);
    const events = await pool.query(`SELECT id::text,action_code,action_status,channel,recommendation_version,payload,actor,created_at FROM crm_next_best_action_events WHERE tenant_id=$1::bigint AND client_id=$2 ORDER BY created_at DESC LIMIT 50`, [req.tenant!.id, recommendation.client_id]);
    return res.json({ ok: true, recommendation, events: events.rows });
  } catch (error: any) {
    return res.status(Number(error?.status || 500)).json({ ok: false, code: error?.code || "CUSTOMER_INTELLIGENCE_ERROR", error: error?.message || "A vendégintelligencia nem tölthető be." });
  }
});

router.get("/events", async (req: TenantAuthRequest, res: Response) => {
  try {
    await ensureSchema();
    const clientId = String(req.query.client_id || "").trim() || null;
    const { rows } = await pool.query(`SELECT id::text,client_id,action_code,action_status,channel,recommendation_version,payload,actor,created_at FROM crm_next_best_action_events WHERE tenant_id=$1::bigint AND ($2::text IS NULL OR client_id=$2) ORDER BY created_at DESC LIMIT 200`, [req.tenant!.id, clientId]);
    return res.json({ ok: true, rows });
  } catch (error: any) {
    return res.status(500).json({ ok: false, code: "NBA_EVENT_READ_ERROR", error: error?.message || "Az NBA események nem tölthetők be." });
  }
});

router.post("/actions", async (req: TenantAuthRequest, res: Response) => {
  try {
    await ensureSchema();
    const clientId = String(req.body?.client_id || "").trim();
    const actionCode = String(req.body?.action_code || "").trim().toUpperCase();
    const actionStatus = String(req.body?.status || "").trim().toLowerCase();
    const channel = String(req.body?.channel || "").trim().toLowerCase() || null;
    if (!clientId || !ACTION_CODES.has(actionCode) || !ACTION_STATUSES.has(actionStatus)) {
      return res.status(400).json({ ok: false, code: "NBA_ACTION_INVALID", error: "Hiányzó vagy érvénytelen client_id, action_code vagy status." });
    }
    const scoped = await loadRows(req, clientId);
    if (!scoped.length) return res.status(404).json({ ok: false, code: "CLIENT_NOT_FOUND", error: "A vendég nem található ebben a tenant/telephely scope-ban." });
    const current = recommend(scoped[0]);
    if (current.action_code !== actionCode) {
      return res.status(409).json({ ok: false, code: "NBA_RECOMMENDATION_CHANGED", error: "A vendég aktuális ajánlása időközben megváltozott.", current });
    }
    const actor = String(req.user?.id || req.user?.email || "");
    const payload = {
      reason: current.action_reason,
      priority: current.priority,
      value_tier: current.value_tier,
      risk_level: current.risk_level,
      suggested_channel: current.suggested_channel,
      note: String(req.body?.note || "").trim() || null,
    };
    const { rows } = await pool.query(`INSERT INTO crm_next_best_action_events(tenant_id,client_id,action_code,action_status,channel,recommendation_version,payload,actor) VALUES($1::bigint,$2,$3,$4,$5,'nba-v1',$6::jsonb,$7) RETURNING id::text,client_id,action_code,action_status,channel,recommendation_version,payload,actor,created_at`, [req.tenant!.id, clientId, actionCode, actionStatus, channel, JSON.stringify(payload), actor]);
    return res.status(201).json({ ok: true, event: rows[0], recommendation: current });
  } catch (error: any) {
    console.error("[customer-intelligence] action failed", error);
    return res.status(Number(error?.status || 500)).json({ ok: false, code: error?.code || "NBA_ACTION_ERROR", error: error?.message || "A Next Best Action esemény nem menthető." });
  }
});

export default router;
