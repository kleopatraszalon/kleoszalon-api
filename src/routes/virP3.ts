import { Router, Response } from "express";
import pool from "../db";
import type { AuthRequest } from "../middleware/auth";
import { requireManagement } from "../middleware/requireRoles";

const router = Router();
router.use(requireManagement);

type Scope = { tenantId: string; locationId: string | null };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const n = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round1 = (value: number) => Math.round(value * 10) / 10;

async function scope(req: AuthRequest, res: Response): Promise<Scope | undefined> {
  const tenantId = String(req.user?.tenant_id || "").trim();
  if (!tenantId) {
    res.status(403).json({ ok: false, error: "A felhasználóhoz nincs tenant rendelve." });
    return;
  }
  const requested = String(req.query.locationId || req.query.location_id || "").trim();
  if (!requested) return { tenantId, locationId: null };
  if (!UUID.test(requested)) {
    res.status(400).json({ ok: false, error: "Érvénytelen telephelyazonosító." });
    return;
  }
  const row = (
    await pool.query(`SELECT id::text FROM locations WHERE id=$1::uuid AND tenant_id=$2::uuid`, [requested, tenantId])
  ).rows[0];
  if (!row) {
    res.status(403).json({ ok: false, error: "A telephely nem tartozik a tenantjához." });
    return;
  }
  return { tenantId, locationId: requested };
}

router.get("/churn-radar", async (req: AuthRequest, res: Response) => {
  try {
    const s = await scope(req, res);
    if (!s) return;
    const rows = (
      await pool.query(
        `WITH visits AS (
           SELECT a.client_id,
                  COUNT(*) FILTER (WHERE a.start_time < now())::int AS visits,
                  COUNT(*) FILTER (WHERE lower(COALESCE(a.status,'')) IN ('no_show','no-show','noshow'))::int AS no_shows,
                  COUNT(*) FILTER (WHERE lower(COALESCE(a.status,'')) IN ('cancelled','canceled'))::int AS cancellations,
                  MAX(a.start_time) FILTER (WHERE a.start_time < now()) AS last_visit,
                  MIN(a.start_time) FILTER (WHERE a.start_time >= now() AND lower(COALESCE(a.status,'')) NOT IN ('cancelled','canceled','no_show','no-show')) AS next_visit,
                  AVG(gap_days) FILTER (WHERE gap_days BETWEEN 7 AND 365) AS avg_cycle_days
           FROM (
             SELECT a0.*,
                    EXTRACT(EPOCH FROM (a0.start_time - LAG(a0.start_time) OVER (PARTITION BY a0.client_id ORDER BY a0.start_time))) / 86400.0 AS gap_days
             FROM appointments a0
             WHERE a0.tenant_id=$1::uuid AND ($2::uuid IS NULL OR a0.location_id=$2::uuid)
           ) a
           GROUP BY a.client_id
         ), value AS (
           SELECT w.client_id,
                  COALESCE(SUM(COALESCE(NULLIF(to_jsonb(w)->>'gross_total','')::numeric,NULLIF(to_jsonb(w)->>'total_amount','')::numeric,0)),0)::numeric AS lifetime_value
           FROM work_orders w
           WHERE w.tenant_id=$1::uuid AND ($2::uuid IS NULL OR w.location_id=$2::uuid)
             AND lower(COALESCE(w.status,''))='completed'
           GROUP BY w.client_id
         )
         SELECT c.id::text AS client_id, COALESCE(c.full_name,c.name,'Vendég') AS client_name,
                c.email,c.phone,COALESCE(v.visits,0)::int AS visits,COALESCE(v.no_shows,0)::int AS no_shows,
                COALESCE(v.cancellations,0)::int AS cancellations,v.last_visit,v.next_visit,
                COALESCE(v.avg_cycle_days,45)::numeric AS avg_cycle_days,COALESCE(val.lifetime_value,0)::numeric AS lifetime_value
         FROM clients c
         LEFT JOIN visits v ON v.client_id=c.id
         LEFT JOIN value val ON val.client_id=c.id
         WHERE c.tenant_id=$1::uuid AND ($2::uuid IS NULL OR c.location_id=$2::uuid OR c.location_id IS NULL)
           AND COALESCE(v.visits,0)>0
         ORDER BY v.last_visit ASC NULLS FIRST
         LIMIT 500`,
        [s.tenantId, s.locationId]
      )
    ).rows;

    const now = Date.now();
    const items = rows.map((r: any) => {
      const recency = r.last_visit ? Math.max(0, (now - new Date(r.last_visit).getTime()) / 86400000) : 999;
      const cycle = clamp(n(r.avg_cycle_days) || 45, 14, 180);
      const overdueRatio = recency / cycle;
      const behaviorPenalty = Math.min(20, n(r.no_shows) * 5 + n(r.cancellations) * 2);
      const loyaltyRelief = Math.min(15, n(r.visits) * 0.7 + n(r.lifetime_value) / 50000);
      const nextBookingRelief = r.next_visit ? 45 : 0;
      const score = clamp(Math.round((overdueRatio - 0.65) * 55 + 35 + behaviorPenalty - loyaltyRelief - nextBookingRelief), 0, 100);
      const risk = score >= 75 ? "CRITICAL" : score >= 55 ? "HIGH" : score >= 35 ? "MEDIUM" : "LOW";
      return {
        ...r,
        visits: n(r.visits),
        no_shows: n(r.no_shows),
        cancellations: n(r.cancellations),
        lifetime_value: Math.round(n(r.lifetime_value)),
        avg_cycle_days: round1(cycle),
        recency_days: Math.round(recency),
        churn_score: score,
        risk,
        reason: r.next_visit
          ? "Van jövőbeli foglalása."
          : overdueRatio >= 1.5
            ? "A vendég jelentősen túllépte a saját megszokott visszatérési ciklusát."
            : overdueRatio >= 1
              ? "A vendég elérte vagy túllépte a megszokott visszatérési ciklusát."
              : "A visszatérési ciklus alapján még nem kritikus.",
      };
    }).sort((a: any, b: any) => b.churn_score - a.churn_score);

    res.json({
      ok: true,
      model: "explainable_cycle_recency_churn_v1",
      autonomous_outreach: false,
      summary: {
        clients: items.length,
        critical: items.filter((x: any) => x.risk === "CRITICAL").length,
        high: items.filter((x: any) => x.risk === "HIGH").length,
        revenue_at_risk: items.filter((x: any) => x.churn_score >= 55).reduce((a: number, x: any) => a + x.lifetime_value, 0),
      },
      items: items.slice(0, 250),
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || "churn_radar_failed" });
  }
});

router.get("/next-visit", async (req: AuthRequest, res: Response) => {
  try {
    const s = await scope(req, res);
    if (!s) return;
    const horizonDays = clamp(n(req.query.horizonDays) || 30, 7, 90);
    const rows = (
      await pool.query(
        `WITH ordered AS (
           SELECT a.client_id,a.start_time,aps.service_id,srv.name AS service_name,
                  EXTRACT(EPOCH FROM (a.start_time-LAG(a.start_time) OVER(PARTITION BY a.client_id,aps.service_id ORDER BY a.start_time)))/86400.0 AS gap_days
           FROM appointments a
           JOIN appointment_services aps ON aps.appointment_id=a.id
           LEFT JOIN services srv ON srv.id=aps.service_id
           WHERE a.tenant_id=$1::uuid AND ($2::uuid IS NULL OR a.location_id=$2::uuid)
             AND a.start_time<now() AND lower(COALESCE(a.status,'')) NOT IN ('cancelled','canceled','no_show','no-show')
         ), cycles AS (
           SELECT client_id,service_id,MAX(start_time) last_visit,MAX(service_name) service_name,
                  AVG(gap_days) FILTER(WHERE gap_days BETWEEN 7 AND 365) avg_cycle_days,COUNT(*)::int visits
           FROM ordered GROUP BY client_id,service_id
         ), future AS (
           SELECT DISTINCT client_id FROM appointments
           WHERE tenant_id=$1::uuid AND ($2::uuid IS NULL OR location_id=$2::uuid) AND start_time>=now()
             AND lower(COALESCE(status,'')) NOT IN ('cancelled','canceled','no_show','no-show')
         )
         SELECT c.id::text client_id,COALESCE(c.full_name,c.name,'Vendég') client_name,c.email,c.phone,
                cy.service_id::text,COALESCE(cy.service_name,'Szolgáltatás') service_name,cy.last_visit,
                COALESCE(cy.avg_cycle_days,45)::numeric avg_cycle_days,cy.visits
         FROM cycles cy JOIN clients c ON c.id=cy.client_id LEFT JOIN future f ON f.client_id=cy.client_id
         WHERE f.client_id IS NULL AND cy.visits>=1
         ORDER BY cy.last_visit DESC LIMIT 500`,
        [s.tenantId, s.locationId]
      )
    ).rows;
    const now = Date.now();
    const items = rows.map((r: any) => {
      const cycle = clamp(n(r.avg_cycle_days) || 45, 14, 180);
      const due = new Date(new Date(r.last_visit).getTime() + cycle * 86400000);
      const daysUntil = Math.ceil((due.getTime() - now) / 86400000);
      return {
        ...r,
        visits: n(r.visits),
        avg_cycle_days: round1(cycle),
        predicted_next_visit: due.toISOString().slice(0, 10),
        days_until_due: daysUntil,
        status: daysUntil < -7 ? "OVERDUE" : daysUntil <= 7 ? "DUE_SOON" : "UPCOMING",
      };
    }).filter((x: any) => x.days_until_due <= horizonDays).sort((a: any, b: any) => a.days_until_due - b.days_until_due);
    res.json({
      ok: true,
      horizon_days: horizonDays,
      model: "service_cycle_prediction_v1",
      autonomous_outreach: false,
      summary: {
        due: items.length,
        overdue: items.filter((x: any) => x.status === "OVERDUE").length,
        due_7d: items.filter((x: any) => x.days_until_due >= 0 && x.days_until_due <= 7).length,
      },
      items: items.slice(0, 250),
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || "next_visit_failed" });
  }
});

router.get("/smart-pricing", async (req: AuthRequest, res: Response) => {
  try {
    const s = await scope(req, res);
    if (!s) return;
    const days = clamp(n(req.query.days) || 14, 7, 30);
    const rows = (
      await pool.query(
        `WITH hist AS (
           SELECT EXTRACT(ISODOW FROM a.start_time)::int dow,EXTRACT(HOUR FROM a.start_time)::int hour,
                  COUNT(DISTINCT a.id)::int bookings,COALESCE(AVG(aps.price),0)::numeric avg_price
           FROM appointments a LEFT JOIN appointment_services aps ON aps.appointment_id=a.id
           WHERE a.tenant_id=$1::uuid AND ($2::uuid IS NULL OR a.location_id=$2::uuid)
             AND a.start_time>=now()-interval '90 days' AND a.start_time<now()
             AND lower(COALESCE(a.status,'')) NOT IN ('cancelled','canceled','no_show','no-show')
           GROUP BY 1,2
         ), future AS (
           SELECT a.start_time::date day,EXTRACT(ISODOW FROM a.start_time)::int dow,EXTRACT(HOUR FROM a.start_time)::int hour,
                  COUNT(DISTINCT a.id)::int booked
           FROM appointments a
           WHERE a.tenant_id=$1::uuid AND ($2::uuid IS NULL OR a.location_id=$2::uuid)
             AND a.start_time>=now() AND a.start_time<now()+($3::text||' days')::interval
             AND lower(COALESCE(a.status,'')) NOT IN ('cancelled','canceled','no_show','no-show')
           GROUP BY 1,2,3
         )
         SELECT f.day,f.hour,f.booked,COALESCE(h.bookings,0)::int historical_bookings,COALESCE(h.avg_price,0)::numeric avg_price
         FROM future f LEFT JOIN hist h ON h.dow=f.dow AND h.hour=f.hour
         ORDER BY f.day,f.hour`,
        [s.tenantId, s.locationId, days]
      )
    ).rows;
    const maxHistorical = Math.max(1, ...rows.map((r: any) => n(r.historical_bookings)));
    const items = rows.map((r: any) => {
      const demandIndex = clamp(Math.round((n(r.historical_bookings) / maxHistorical) * 100), 0, 100);
      const booked = n(r.booked);
      let action = "HOLD";
      let suggestedDiscount = 0;
      if (demandIndex < 30 && booked <= 1) { action = "DISCOUNT"; suggestedDiscount = 10; }
      else if (demandIndex < 50 && booked <= 2) { action = "DISCOUNT"; suggestedDiscount = 5; }
      else if (demandIndex >= 80) action = "PROTECT_PRICE";
      const avgPrice = n(r.avg_price);
      return {
        day: r.day,
        hour: n(r.hour),
        booked,
        demand_index: demandIndex,
        avg_price: Math.round(avgPrice),
        recommendation: action,
        suggested_discount_percent: suggestedDiscount,
        suggested_price: suggestedDiscount ? Math.round(avgPrice * (1 - suggestedDiscount / 100)) : Math.round(avgPrice),
        rationale: action === "DISCOUNT" ? "Alacsony historikus kereslet és gyenge előfoglaltság." : action === "PROTECT_PRICE" ? "Erős historikus kereslet; kedvezmény nem indokolt." : "Normál kereslet; ár tartása javasolt.",
      };
    });
    res.json({
      ok: true,
      days,
      model: "demand_index_price_recommendation_v1",
      automatic_price_changes: false,
      summary: {
        slots: items.length,
        discount_candidates: items.filter((x: any) => x.recommendation === "DISCOUNT").length,
        protected_slots: items.filter((x: any) => x.recommendation === "PROTECT_PRICE").length,
      },
      items,
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || "smart_pricing_failed" });
  }
});

router.get("/membership-intelligence", async (req: AuthRequest, res: Response) => {
  try {
    const s = await scope(req, res);
    if (!s) return;
    const rows = (
      await pool.query(
        `WITH a AS (
           SELECT client_id,COUNT(*) FILTER(WHERE start_time>=now()-interval '365 days' AND start_time<now())::int visits_12m,
                  MAX(start_time) FILTER(WHERE start_time<now()) last_visit
           FROM appointments
           WHERE tenant_id=$1::uuid AND ($2::uuid IS NULL OR location_id=$2::uuid)
             AND lower(COALESCE(status,'')) NOT IN ('cancelled','canceled','no_show','no-show')
           GROUP BY client_id
         ),v AS (
           SELECT client_id,COALESCE(SUM(COALESCE(NULLIF(to_jsonb(w)->>'gross_total','')::numeric,NULLIF(to_jsonb(w)->>'total_amount','')::numeric,0)),0)::numeric spend_12m
           FROM work_orders w
           WHERE w.tenant_id=$1::uuid AND ($2::uuid IS NULL OR w.location_id=$2::uuid)
             AND lower(COALESCE(w.status,''))='completed' AND COALESCE(w.completed_at,w.updated_at)>=now()-interval '365 days'
           GROUP BY client_id
         )
         SELECT c.id::text client_id,COALESCE(c.full_name,c.name,'Vendég') client_name,c.email,c.phone,
                COALESCE(a.visits_12m,0)::int visits_12m,a.last_visit,COALESCE(v.spend_12m,0)::numeric spend_12m
         FROM clients c LEFT JOIN a ON a.client_id=c.id LEFT JOIN v ON v.client_id=c.id
         WHERE c.tenant_id=$1::uuid AND ($2::uuid IS NULL OR c.location_id=$2::uuid OR c.location_id IS NULL)
           AND (COALESCE(a.visits_12m,0)>0 OR COALESCE(v.spend_12m,0)>0)
         ORDER BY spend_12m DESC,visits_12m DESC LIMIT 500`,
        [s.tenantId, s.locationId]
      )
    ).rows;
    const items = rows.map((r: any) => {
      const visits = n(r.visits_12m);
      const spend = n(r.spend_12m);
      const avgBasket = visits ? spend / visits : 0;
      let plan = "NONE";
      let fit = 0;
      if (visits >= 12 || spend >= 300000) { plan = "VIP"; fit = clamp(Math.round(65 + visits + spend / 50000), 0, 100); }
      else if (visits >= 7 || spend >= 150000) { plan = "GOLD"; fit = clamp(Math.round(55 + visits * 2 + spend / 30000), 0, 100); }
      else if (visits >= 4 || spend >= 70000) { plan = "BASIC"; fit = clamp(Math.round(45 + visits * 3 + spend / 20000), 0, 100); }
      return {
        ...r,
        visits_12m: visits,
        spend_12m: Math.round(spend),
        avg_basket: Math.round(avgBasket),
        recommended_plan: plan,
        membership_fit_score: fit,
        rationale: plan === "NONE" ? "Még kevés aktivitás a membership ajánláshoz." : `${visits} látogatás és ${Math.round(spend).toLocaleString('hu-HU')} Ft 12 havi költés alapján.`,
      };
    }).sort((a: any, b: any) => b.membership_fit_score - a.membership_fit_score);
    res.json({
      ok: true,
      model: "frequency_value_membership_fit_v1",
      automatic_enrollment: false,
      summary: {
        candidates: items.filter((x: any) => x.recommended_plan !== "NONE").length,
        vip: items.filter((x: any) => x.recommended_plan === "VIP").length,
        gold: items.filter((x: any) => x.recommended_plan === "GOLD").length,
        basic: items.filter((x: any) => x.recommended_plan === "BASIC").length,
      },
      items: items.slice(0, 250),
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || "membership_intelligence_failed" });
  }
});

export default router;
