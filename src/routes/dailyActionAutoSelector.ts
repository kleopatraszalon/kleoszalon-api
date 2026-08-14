import { Router } from "express";
import axios from "axios";
import db from "../db";
import { AuthRequest } from "../middleware/auth";

const router = Router();
const BUDAPEST_TZ = "Europe/Budapest";
const HISTORY_DAYS = 28;
const RECENT_CAMPAIGN_DAYS = 14;

type Candidate = {
  serviceId: string;
  name: string;
  price: number;
  durationMinutes: number;
  bookingsToday: number;
  bookedMinutesToday: number;
  avgDailyBookings28d: number;
  avgDailyBookedMinutes28d: number;
  demandGapPct: number;
  locationOccupancyPct: number;
  recentCampaigns: number;
  score: number;
  suggestedDiscountPct: number;
  reason: string;
  headline: string;
  description: string;
};

let ensurePromise: Promise<void> | null = null;
async function ensureSchema() {
  if (ensurePromise) return ensurePromise;
  ensurePromise = db.query(`
    ALTER TABLE services ADD COLUMN IF NOT EXISTS daily_action_enabled boolean NOT NULL DEFAULT false;
    CREATE TABLE IF NOT EXISTS daily_action_campaigns(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      headline text NOT NULL,
      description_html text NOT NULL,
      image_url text,
      cta_label text DEFAULT 'Foglalok',
      cta_url text DEFAULT '/foglalas',
      discount_text text,
      valid_from timestamptz NOT NULL,
      valid_until timestamptz NOT NULL,
      audience jsonb DEFAULT '{"type":"all"}'::jsonb,
      channels jsonb DEFAULT '["app"]'::jsonb,
      status text DEFAULT 'draft',
      recipient_count int DEFAULT 0,
      sent_email int DEFAULT 0,
      sent_sms int DEFAULT 0,
      sent_push int DEFAULT 0,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS service_id uuid;
    ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS auto_selector_meta jsonb NOT NULL DEFAULT '{}'::jsonb;
    CREATE INDEX IF NOT EXISTS idx_daily_action_campaigns_service_created ON daily_action_campaigns(service_id,created_at DESC);
  `).then(() => undefined).catch((error) => {
    ensurePromise = null;
    throw error;
  });
  return ensurePromise;
}

router.use(async (_req, _res, next) => {
  try {
    await ensureSchema();
    next();
  } catch (error) {
    next(error);
  }
});

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
function n(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
function round(value: number, digits = 1) {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}
function isDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}
function budapestDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BUDAPEST_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function actorKey(req: AuthRequest) {
  return req.user?.email ? `email:${String(req.user.email).toLowerCase()}` : `user:${String(req.user?.id || "unknown")}`;
}

function deterministicCopy(name: string, discountPct: number, reason: string) {
  const offer = discountPct > 0 ? `${discountPct}% kedvezménnyel` : "kiemelt napi ajánlatként";
  return {
    headline: `${name} – mai ajánlat`,
    description: `Foglaljon ${name} szolgáltatásra ${offer}. Az ajánlatot a rendszer a mai foglaltság és a szolgáltatás kihasználtsága alapján javasolja.`,
    rationale: reason,
    aiMode: "fallback" as const,
  };
}

async function aiCopy(req: AuthRequest, candidate: Candidate) {
  const fallback = deterministicCopy(candidate.name, candidate.suggestedDiscountPct, candidate.reason);
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) return fallback;
  try {
    const monthlyBudget = n(process.env.AI_MONTHLY_BUDGET_USD || 10);
    if (monthlyBudget > 0) {
      const usage = await db.query(`SELECT COALESCE(SUM(estimated_cost_usd),0)::numeric total FROM ai_usage_log WHERE created_at>=date_trunc('month',now())`);
      if (n(usage.rows[0]?.total) >= monthlyBudget) return fallback;
    }
    const prompt = {
      service: candidate.name,
      price_huf: candidate.price,
      suggested_discount_pct: candidate.suggestedDiscountPct,
      bookings_today: candidate.bookingsToday,
      avg_daily_bookings_28d: candidate.avgDailyBookings28d,
      location_occupancy_pct: candidate.locationOccupancyPct,
      score: candidate.score,
      deterministic_reason: candidate.reason,
    };
    const response = await axios.post(
      "https://api.openai.com/v1/responses",
      {
        model: process.env.OPENAI_MODEL || "gpt-5-mini",
        store: false,
        max_output_tokens: 300,
        instructions: "A Kleopátra Szépségszalonok marketing asszisztense vagy. A kapott tényadatokból készíts rövid magyar napi akció szöveget. Ne találj ki árat, kedvezményt, eredményt, egészségügyi állítást vagy kapacitásadatot. Csak JSON-t adj vissza ezzel a három string mezővel: headline, description, rationale. A headline legfeljebb 70 karakter, a description legfeljebb 260 karakter, a rationale egy mondat.",
        input: [{ role: "user", content: [{ type: "input_text", text: JSON.stringify(prompt) }] }],
      },
      { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, timeout: 20_000 },
    );
    const data: any = response.data;
    let output = String(data?.output_text || "").trim();
    if (!output && Array.isArray(data?.output)) {
      output = data.output.flatMap((item: any) => Array.isArray(item?.content) ? item.content : [])
        .filter((item: any) => item?.type === "output_text" && typeof item?.text === "string")
        .map((item: any) => item.text).join("\n").trim();
    }
    output = output.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(output || "{}");
    const headline = String(parsed?.headline || "").trim().slice(0, 70);
    const description = String(parsed?.description || "").trim().slice(0, 260);
    const rationale = String(parsed?.rationale || candidate.reason).trim().slice(0, 320);
    if (!headline || !description) return fallback;
    const inputTokens = n(data?.usage?.input_tokens);
    const outputTokens = n(data?.usage?.output_tokens);
    const inputRate = n(process.env.OPENAI_INPUT_USD_PER_1M || 0.25);
    const outputRate = n(process.env.OPENAI_OUTPUT_USD_PER_1M || 2);
    const estimated = inputTokens / 1_000_000 * inputRate + outputTokens / 1_000_000 * outputRate;
    await db.query(`INSERT INTO ai_usage_log(user_key,model,input_tokens,output_tokens,estimated_cost_usd) VALUES($1,$2,$3,$4,$5)`, [actorKey(req), data?.model || process.env.OPENAI_MODEL || "gpt-5-mini", inputTokens, outputTokens, estimated]).catch(() => undefined);
    return { headline, description, rationale, aiMode: "openai" as const };
  } catch (error: any) {
    console.warn("[daily-action-auto-selector] AI copy fallback:", error?.response?.status || error?.message || error);
    return fallback;
  }
}

async function buildRecommendation(req: AuthRequest, date: string, locationId: string | null) {
  const params = [date, locationId];
  const [eligible, todayStats, historyStats, recentStats, shiftStats, bookingStats] = await Promise.all([
    db.query(`SELECT id::text,name,COALESCE(promo_price,list_price,base_price,0)::numeric price,COALESCE(duration_minutes,30)::int duration_minutes FROM services WHERE COALESCE(is_active,true)=true AND COALESCE(daily_action_enabled,false)=true ORDER BY name`),
    db.query(`SELECT aps.service_id::text service_id,COUNT(*)::int bookings,COALESCE(SUM(aps.duration_minutes),0)::numeric booked_minutes FROM appointment_services aps JOIN appointments a ON a.id=aps.appointment_id LEFT JOIN employees e ON e.id=a.employee_id WHERE (a.start_time AT TIME ZONE '${BUDAPEST_TZ}')::date=$1::date AND a.status NOT IN('cancelled','canceled','no_show') AND ($2::uuid IS NULL OR COALESCE(a.location_id,e.location_id)=$2::uuid) GROUP BY aps.service_id`, params),
    db.query(`SELECT aps.service_id::text service_id,(COUNT(*)::numeric/${HISTORY_DAYS}) avg_daily_bookings,(COALESCE(SUM(aps.duration_minutes),0)::numeric/${HISTORY_DAYS}) avg_daily_booked_minutes FROM appointment_services aps JOIN appointments a ON a.id=aps.appointment_id LEFT JOIN employees e ON e.id=a.employee_id WHERE (a.start_time AT TIME ZONE '${BUDAPEST_TZ}')::date >= $1::date-${HISTORY_DAYS} AND (a.start_time AT TIME ZONE '${BUDAPEST_TZ}')::date < $1::date AND a.status NOT IN('cancelled','canceled','no_show') AND ($2::uuid IS NULL OR COALESCE(a.location_id,e.location_id)=$2::uuid) GROUP BY aps.service_id`, params),
    db.query(`SELECT service_id::text service_id,COUNT(*)::int cnt FROM daily_action_campaigns WHERE service_id IS NOT NULL AND created_at>=now()-interval '${RECENT_CAMPAIGN_DAYS} days' GROUP BY service_id`),
    db.query(`SELECT COALESCE(SUM(GREATEST(0,EXTRACT(EPOCH FROM (ws.ends_at-ws.starts_at))/60-COALESCE(ws.break_minutes,0))),0)::numeric scheduled_minutes FROM work_shifts ws LEFT JOIN employees e ON e.id=ws.employee_id WHERE ws.work_date=$1::date AND ws.status<>'cancelled' AND ($2::uuid IS NULL OR COALESCE(ws.location_id,e.location_id)=$2::uuid)`, params).catch(() => ({ rows: [{ scheduled_minutes: 0 }] } as any)),
    db.query(`SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (a.end_time-a.start_time))/60),0)::numeric booked_minutes FROM appointments a LEFT JOIN employees e ON e.id=a.employee_id WHERE (a.start_time AT TIME ZONE '${BUDAPEST_TZ}')::date=$1::date AND a.status NOT IN('cancelled','canceled','no_show') AND ($2::uuid IS NULL OR COALESCE(a.location_id,e.location_id)=$2::uuid)`, params),
  ]);

  const scheduledMinutes = n(shiftStats.rows[0]?.scheduled_minutes);
  const bookedMinutes = n(bookingStats.rows[0]?.booked_minutes);
  const locationOccupancyPct = scheduledMinutes > 0 ? round(clamp(bookedMinutes / scheduledMinutes * 100, 0, 100), 1) : 0;
  const today = new Map(todayStats.rows.map((r: any) => [String(r.service_id), r]));
  const history = new Map(historyStats.rows.map((r: any) => [String(r.service_id), r]));
  const recent = new Map(recentStats.rows.map((r: any) => [String(r.service_id), n(r.cnt)]));

  const candidates: Candidate[] = eligible.rows.map((service: any) => {
    const id = String(service.id);
    const t: any = today.get(id) || {};
    const h: any = history.get(id) || {};
    const bookingsToday = n(t.bookings);
    const bookedMinutesToday = n(t.booked_minutes);
    const avgDailyBookings28d = round(n(h.avg_daily_bookings), 2);
    const avgDailyBookedMinutes28d = round(n(h.avg_daily_booked_minutes), 1);
    const bookingShortfall = avgDailyBookings28d > 0 ? clamp((1 - bookingsToday / avgDailyBookings28d) * 100, 0, 100) : (bookingsToday === 0 ? 45 : 0);
    const minuteShortfall = avgDailyBookedMinutes28d > 0 ? clamp((1 - bookedMinutesToday / avgDailyBookedMinutes28d) * 100, 0, 100) : (bookedMinutesToday === 0 ? 45 : 0);
    const demandGapPct = round(bookingShortfall * 0.65 + minuteShortfall * 0.35, 1);
    const vacancyPct = clamp(100 - locationOccupancyPct, 0, 100);
    const recentCampaigns = recent.get(id) || 0;
    const recentPenalty = Math.min(36, recentCampaigns * 12);
    const zeroBookingBoost = bookingsToday === 0 ? 8 : 0;
    const score = round(clamp(demandGapPct * 0.65 + vacancyPct * 0.25 + zeroBookingBoost - recentPenalty, 0, 100), 1);
    const suggestedDiscountPct = n(service.price) <= 0 ? 0 : score >= 80 && locationOccupancyPct < 55 ? 20 : score >= 62 ? 15 : 10;
    const reasonParts = [
      avgDailyBookings28d > 0 ? `ma ${bookingsToday} foglalás, a 28 napos napi átlag ${avgDailyBookings28d}` : `ma ${bookingsToday} foglalás; még nincs stabil 28 napos bázis`,
      scheduledMinutes > 0 ? `a telephely foglaltsága ${locationOccupancyPct}%` : "munkaidő-kapacitás nem áll rendelkezésre, ezért a foglalási trend kap nagyobb súlyt",
      recentCampaigns > 0 ? `${recentCampaigns} alkalommal szerepelt az elmúlt ${RECENT_CAMPAIGN_DAYS} napban` : `nem szerepelt az elmúlt ${RECENT_CAMPAIGN_DAYS} nap napi akcióiban`,
    ];
    const reason = reasonParts.join("; ") + ".";
    const fallback = deterministicCopy(String(service.name), suggestedDiscountPct, reason);
    return {
      serviceId: id,
      name: String(service.name),
      price: n(service.price),
      durationMinutes: n(service.duration_minutes) || 30,
      bookingsToday,
      bookedMinutesToday: round(bookedMinutesToday, 1),
      avgDailyBookings28d,
      avgDailyBookedMinutes28d,
      demandGapPct,
      locationOccupancyPct,
      recentCampaigns,
      score,
      suggestedDiscountPct,
      reason,
      headline: fallback.headline,
      description: fallback.description,
    };
  }).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "hu"));

  const top = candidates[0] || null;
  if (!top) return { date, locationId, locationOccupancyPct, scheduledMinutes: round(scheduledMinutes, 1), bookedMinutes: round(bookedMinutes, 1), aiMode: "fallback", recommended: null, candidates: [] };
  const copy = await aiCopy(req, top);
  const recommended = { ...top, headline: copy.headline, description: copy.description, reason: copy.rationale };
  return {
    date,
    locationId,
    locationOccupancyPct,
    scheduledMinutes: round(scheduledMinutes, 1),
    bookedMinutes: round(bookedMinutes, 1),
    aiMode: copy.aiMode,
    recommended,
    candidates: [recommended, ...candidates.slice(1)].slice(0, 8),
  };
}

router.get("/recommendation", async (req: AuthRequest, res, next) => {
  try {
    const date = String(req.query.date || budapestDate());
    const locationId = String(req.query.location_id || "").trim() || null;
    if (!isDate(date)) return res.status(400).json({ message: "Érvényes YYYY-MM-DD dátum szükséges." });
    const result = await buildRecommendation(req, date, locationId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.patch("/service/:serviceId/eligibility", async (req: AuthRequest, res, next) => {
  try {
    const enabled = req.body?.enabled === true;
    const { rows } = await db.query(`UPDATE services SET daily_action_enabled=$2 WHERE id=$1::uuid RETURNING id::text,name,daily_action_enabled`, [req.params.serviceId, enabled]);
    if (!rows[0]) return res.status(404).json({ message: "A szolgáltatás nem található." });
    res.json(rows[0]);
  } catch (error) {
    next(error);
  }
});

router.post("/create-draft", async (req: AuthRequest, res, next) => {
  try {
    const date = String(req.body?.date || budapestDate());
    const locationId = String(req.body?.location_id || "").trim() || null;
    if (!isDate(date)) return res.status(400).json({ message: "Érvényes YYYY-MM-DD dátum szükséges." });
    if (date < budapestDate()) return res.status(400).json({ message: "Múltbeli napra nem hozható létre napi akció." });
    const result: any = await buildRecommendation(req, date, locationId);
    const requestedId = String(req.body?.service_id || "").trim();
    const selected: Candidate | undefined = requestedId ? result.candidates.find((x: Candidate) => x.serviceId === requestedId) : result.recommended;
    if (!selected) return res.status(409).json({ message: "Nincs napi akcióra engedélyezett aktív szolgáltatás." });
    const inputDiscount = req.body?.discount_pct;
    const discountPct = inputDiscount === undefined || inputDiscount === null || inputDiscount === "" ? selected.suggestedDiscountPct : clamp(Math.round(n(inputDiscount)), 0, 30);
    const selectedCopy = selected.serviceId === result.recommended?.serviceId ? selected : { ...selected, ...await aiCopy(req, selected) };
    const meta = {
      source: "auto-selector",
      algorithm: "occupancy-service-demand-v1",
      date,
      location_id: locationId,
      score: selected.score,
      suggested_discount_pct: selected.suggestedDiscountPct,
      applied_discount_pct: discountPct,
      bookings_today: selected.bookingsToday,
      avg_daily_bookings_28d: selected.avgDailyBookings28d,
      location_occupancy_pct: selected.locationOccupancyPct,
      reason: selectedCopy.reason,
      ai_mode: result.aiMode,
      created_by: actorKey(req),
    };
    const discountText = discountPct > 0 ? `${discountPct}% kedvezmény` : "Kiemelt napi ajánlat";
    const { rows } = await db.query(`
      INSERT INTO daily_action_campaigns(
        name,headline,description_html,cta_label,cta_url,discount_text,valid_from,valid_until,audience,channels,status,service_id,auto_selector_meta
      ) VALUES(
        $1,$2,$3,'Foglalok','/foglalas',$4,
        GREATEST(now(),($5::date::timestamp AT TIME ZONE '${BUDAPEST_TZ}')),
        (($5::date+1)::timestamp AT TIME ZONE '${BUDAPEST_TZ}')-interval '1 second',
        $6::jsonb,'["app"]'::jsonb,'draft',$7::uuid,$8::jsonb
      ) RETURNING *`, [
      `AUTO ${date} – ${selected.name}`,
      selectedCopy.headline,
      `<p>${escapeHtml(selectedCopy.description)}</p>`,
      discountText,
      date,
      JSON.stringify({ type: "all" }),
      selected.serviceId,
      JSON.stringify(meta),
    ]);
    res.status(201).json({ campaign: rows[0], recommendation: { ...selected, ...selectedCopy }, aiMode: result.aiMode });
  } catch (error) {
    next(error);
  }
});

export default router;
