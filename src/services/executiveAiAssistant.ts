import axios from "axios";
import cron from "node-cron";
import db from "../db";
import { sendEmail } from "../mailer";
import { getApmAdminRecipients } from "./apmAlertDelivery";

const TZ = "Europe/Budapest";
const AI_USER_KEY = "system:executive-ai";
const ALERT_COOLDOWN_MINUTES = Math.max(30, Number(process.env.EXECUTIVE_AI_ALERT_COOLDOWN_MINUTES || 180));
let schemaPromise: Promise<void> | null = null;
let schedulerStarted = false;

type Severity = "ok" | "info" | "warning" | "critical" | "unknown";
export type ExecutiveSignal = {
  key: string;
  label: string;
  severity: Severity;
  headline: string;
  value?: number | string | null;
  baseline?: number | string | null;
  delta_pct?: number | null;
  evidence: Record<string, unknown>;
  recommendation: string;
};
export type ExecutiveBrief = {
  business_date: string;
  location_id: string | null;
  run_type: string;
  status: "ok" | "warning" | "critical";
  generated_at: string;
  ai_used: boolean;
  narrative: string;
  signals: ExecutiveSignal[];
  recommendations: string[];
};

const n = (v: unknown) => { const x = Number(v ?? 0); return Number.isFinite(x) ? x : 0; };
const round = (v: number, digits = 1) => { const p = 10 ** digits; return Math.round(v * p) / p; };
const pct = (value: number, base: number) => base ? round(((value - base) / Math.abs(base)) * 100, 1) : null;
const locationKey = (id: string | null | undefined) => String(id || "").trim() || "__all__";
const validDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

function budapestParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const get = (type: string) => parts.find(x => x.type === type)?.value || "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}:${get("second")}` };
}
export function currentBudapestDate() { return budapestParts().date; }
function cutoffFor(date: string) { const now = budapestParts(); return date === now.date ? now.time : "23:59:59"; }

async function tableExists(table: string) {
  try { return Boolean((await db.query("SELECT to_regclass($1) IS NOT NULL ok", [`public.${table}`])).rows[0]?.ok); }
  catch { return false; }
}
async function safeRows(sql: string, params: any[] = []) {
  try { return (await db.query(sql, params)).rows; }
  catch (error: any) { console.warn("[executive-ai] metric query skipped:", error?.message || error); return []; }
}

export function ensureExecutiveAiSchema() {
  if (!schemaPromise) {
    schemaPromise = db.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE TABLE IF NOT EXISTS executive_ai_briefs(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_date date NOT NULL,
        location_key text NOT NULL,
        run_type text NOT NULL,
        status text NOT NULL CHECK(status IN('ok','warning','critical')),
        ai_used boolean NOT NULL DEFAULT false,
        narrative text NOT NULL,
        signals jsonb NOT NULL DEFAULT '[]'::jsonb,
        recommendations jsonb NOT NULL DEFAULT '[]'::jsonb,
        generated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(business_date,location_key,run_type)
      );
      CREATE INDEX IF NOT EXISTS executive_ai_briefs_time_idx ON executive_ai_briefs(generated_at DESC);
      CREATE TABLE IF NOT EXISTS executive_ai_alert_events(
        alert_key text PRIMARY KEY,
        business_date date NOT NULL,
        location_key text NOT NULL,
        signal_key text NOT NULL,
        severity text NOT NULL DEFAULT 'critical',
        title text NOT NULL,
        detail text NOT NULL,
        first_seen_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        last_notified_at timestamptz,
        resolved_at timestamptz,
        occurrences bigint NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS executive_ai_alert_open_idx ON executive_ai_alert_events(resolved_at,last_seen_at DESC);
      CREATE TABLE IF NOT EXISTS executive_ai_alert_deliveries(
        id bigserial PRIMARY KEY,
        alert_key text NOT NULL,
        recipient text NOT NULL,
        status text NOT NULL CHECK(status IN('sent','failed','logged')),
        error_text text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `).then(() => undefined).catch(error => { schemaPromise = null; throw error; });
  }
  return schemaPromise;
}

async function revenueSignal(date: string, locationId: string | null): Promise<ExecutiveSignal> {
  if (!(await tableExists("financial_movements"))) return { key:"revenue.change", label:"Forgalom", severity:"unknown", headline:"Nincs pénzügyi forrásadat", evidence:{}, recommendation:"Ellenőrizd a pénzügyi ledger elérhetőségét." };
  const cutoff = cutoffFor(date);
  const current = (await safeRows(`SELECT COALESCE(SUM(amount) FILTER(WHERE direction='income' AND cancelled_at IS NULL),0)::numeric revenue,
      COUNT(*) FILTER(WHERE direction='income' AND cancelled_at IS NULL)::int tx
    FROM financial_movements
    WHERE (occurred_at AT TIME ZONE '${TZ}')::date=$1::date
      AND (occurred_at AT TIME ZONE '${TZ}')::time<=$3::time
      AND ($2::text IS NULL OR location_id::text=$2)`, [date, locationId, cutoff]))[0] || {};
  const baseline = (await safeRows(`WITH daily AS (
      SELECT (occurred_at AT TIME ZONE '${TZ}')::date d,
        COALESCE(SUM(amount) FILTER(WHERE direction='income' AND cancelled_at IS NULL),0)::numeric revenue,
        COUNT(*) FILTER(WHERE direction='income' AND cancelled_at IS NULL)::int tx
      FROM financial_movements
      WHERE (occurred_at AT TIME ZONE '${TZ}')::date BETWEEN $1::date-28 AND $1::date-1
        AND EXTRACT(ISODOW FROM (occurred_at AT TIME ZONE '${TZ}')::date)=EXTRACT(ISODOW FROM $1::date)
        AND (occurred_at AT TIME ZONE '${TZ}')::time<=$3::time
        AND ($2::text IS NULL OR location_id::text=$2)
      GROUP BY 1)
    SELECT COALESCE(AVG(revenue),0)::numeric revenue,COALESCE(AVG(tx),0)::numeric tx FROM daily`, [date, locationId, cutoff]))[0] || {};
  const revenue = n(current.revenue), base = n(baseline.revenue), delta = pct(revenue, base);
  const severity: Severity = delta == null ? "info" : delta <= -25 ? "critical" : delta <= -12 ? "warning" : "ok";
  return {
    key:"revenue.change", label:"Miért csökkent ma a forgalom?", severity,
    headline: delta == null ? `Mai bevétel: ${Math.round(revenue).toLocaleString("hu-HU")} Ft` : `Forgalom ${delta >= 0 ? "+" : ""}${delta}% a négyhetes azonos-napi bázishoz képest`,
    value: round(revenue,0), baseline: round(base,0), delta_pct: delta,
    evidence:{ revenue, baseline_revenue:base, transactions:n(current.tx), baseline_transactions:round(n(baseline.tx),1), cutoff },
    recommendation: severity === "critical" ? "Vizsgáld meg a foglalásszámot, no-show arányt, dolgozói kapacitást és az üres idősávokat; akció csak jóváhagyás után induljon." : "Kövesd az azonos napszakhoz viszonyított trendet." ,
  };
}

async function noShowSignal(date: string, locationId: string | null): Promise<ExecutiveSignal> {
  if (!(await tableExists("appointments"))) return { key:"appointments.no_show", label:"No-show", severity:"unknown", headline:"Nincs foglalási forrásadat", evidence:{}, recommendation:"Ellenőrizd az appointments modult." };
  const current = (await safeRows(`SELECT COUNT(*)::int total,
      COUNT(*) FILTER(WHERE lower(COALESCE(status,'')) IN('no_show','no-show','noshow','nem_jelent_meg'))::int no_show
    FROM appointments WHERE (start_time AT TIME ZONE '${TZ}')::date=$1::date AND ($2::text IS NULL OR location_id::text=$2)`, [date, locationId]))[0] || {};
  const base = (await safeRows(`SELECT COUNT(*)::int total,
      COUNT(*) FILTER(WHERE lower(COALESCE(status,'')) IN('no_show','no-show','noshow','nem_jelent_meg'))::int no_show
    FROM appointments WHERE (start_time AT TIME ZONE '${TZ}')::date BETWEEN $1::date-28 AND $1::date-1 AND ($2::text IS NULL OR location_id::text=$2)`, [date, locationId]))[0] || {};
  const rate = n(current.total) ? n(current.no_show) / n(current.total) * 100 : 0;
  const baseRate = n(base.total) ? n(base.no_show) / n(base.total) * 100 : 0;
  const deltaPp = round(rate - baseRate, 1);
  const severity: Severity = rate >= 15 && deltaPp >= 5 ? "critical" : rate >= 10 && deltaPp >= 3 ? "warning" : "ok";
  return { key:"appointments.no_show", label:"Hol nőtt a no-show?", severity, headline:`No-show ${round(rate,1)}% (${n(current.no_show)}/${n(current.total)})`, value:round(rate,1), baseline:round(baseRate,1), delta_pct:null, evidence:{today_total:n(current.total),today_no_show:n(current.no_show),baseline_total:n(base.total),baseline_no_show:n(base.no_show),delta_percentage_points:deltaPp}, recommendation:severity === "critical" ? "Emeld ki az érintett vendégszegmenst és idősávot; javasolj megerősítő kommunikációt, de automatikus szankciót ne alkalmazz." : "Figyeld a 28 napos bázishoz képesti eltérést." };
}

async function capacitySignal(date: string, locationId: string | null): Promise<ExecutiveSignal> {
  if (!(await tableExists("appointments")) || !(await tableExists("employees"))) return { key:"staff.low_capacity", label:"Dolgozói kapacitás", severity:"unknown", headline:"Nincs elegendő kapacitásadat", evidence:{}, recommendation:"Ellenőrizd a foglalási és dolgozói adatokat." };
  const rows = await safeRows(`WITH service_staff AS (
      SELECT DISTINCT employee_id::text employee_id FROM appointments
       WHERE start_time>=($1::date-60) AND employee_id IS NOT NULL
    ), today AS (
      SELECT employee_id::text employee_id,
        COALESCE(SUM(GREATEST(0,EXTRACT(EPOCH FROM (end_time-start_time))/60)) FILTER(WHERE lower(COALESCE(status,'')) NOT IN('cancelled','canceled','no_show','no-show')),0)::numeric booked_minutes
      FROM appointments WHERE (start_time AT TIME ZONE '${TZ}')::date=$1::date GROUP BY employee_id::text
    ), hist AS (
      SELECT employee_id::text employee_id,
        COALESCE(SUM(GREATEST(0,EXTRACT(EPOCH FROM (end_time-start_time))/60)) / 28.0,0)::numeric avg_daily_minutes
      FROM appointments WHERE (start_time AT TIME ZONE '${TZ}')::date BETWEEN $1::date-28 AND $1::date-1
        AND lower(COALESCE(status,'')) NOT IN('cancelled','canceled','no_show','no-show') GROUP BY employee_id::text
    )
    SELECT e.id::text employee_id,COALESCE(NULLIF(e.full_name,''),concat_ws(' ',e.first_name,e.last_name),e.id::text) employee_name,
      e.location_id::text location_id,COALESCE(t.booked_minutes,0)::numeric booked_minutes,COALESCE(h.avg_daily_minutes,0)::numeric baseline_minutes
    FROM employees e JOIN service_staff s ON s.employee_id=e.id::text
    LEFT JOIN today t ON t.employee_id=e.id::text LEFT JOIN hist h ON h.employee_id=e.id::text
    WHERE COALESCE(e.active,true)=true AND ($2::text IS NULL OR e.location_id::text=$2)
    ORDER BY COALESCE(t.booked_minutes,0) ASC LIMIT 50`, [date, locationId]);
  const low = rows.map((r:any)=>({employee_id:r.employee_id,name:r.employee_name,location_id:r.location_id,booked_minutes:round(n(r.booked_minutes),0),baseline_minutes:round(n(r.baseline_minutes),0),utilization_pct:round(n(r.booked_minutes)/480*100,1)}))
    .filter((r:any)=>r.baseline_minutes>=120 && r.booked_minutes < Math.max(120,r.baseline_minutes*0.55)).slice(0,10);
  const severity: Severity = low.length >= 3 ? "warning" : "ok";
  return { key:"staff.low_capacity", label:"Melyik dolgozó kapacitása alacsony?", severity, headline:low.length?`${low.length} munkatársnál szokatlanul alacsony a foglalási terhelés`:`Nem látszik jelentős kapacitásesés`, value:low.length, evidence:{low_capacity_staff:low,reference_capacity_minutes:480}, recommendation:low.length?"Vizsgáld meg az üres idősávokat, szolgáltatásmixet és szabadság/beosztás adatot; ne értékeld automatikusan a dolgozót pusztán kihasználtság alapján.":"Nincs szükség kapacitás-beavatkozásra." };
}

async function stockSignal(locationId: string | null): Promise<ExecutiveSignal> {
  if (!(await tableExists("inventory_warehouse_balances")) || !(await tableExists("inventory_warehouses")) || !(await tableExists("products"))) return { key:"stock.risk", label:"Készletkockázat", severity:"unknown", headline:"Nincs készletforrás", evidence:{}, recommendation:"Ellenőrizd a készletmodult." };
  const rows = await safeRows(`WITH usage14 AS (
      SELECT warehouse_id::text warehouse_id,product_id::text product_id,
        COALESCE(SUM(CASE WHEN quantity<0 THEN -quantity ELSE 0 END),0)/14.0 avg_daily_out
      FROM inventory_movements WHERE created_at>=now()-interval '14 days' GROUP BY warehouse_id::text,product_id::text)
    SELECT w.location_id::text location_id,w.name warehouse_name,b.product_id::text product_id,p.name product_name,
      b.quantity::numeric quantity,b.min_quantity::numeric min_quantity,COALESCE(u.avg_daily_out,0)::numeric avg_daily_out,
      CASE WHEN COALESCE(u.avg_daily_out,0)>0 THEN b.quantity/u.avg_daily_out ELSE NULL END days_to_zero
    FROM inventory_warehouse_balances b JOIN inventory_warehouses w ON w.id=b.warehouse_id
    JOIN products p ON p.id=b.product_id LEFT JOIN usage14 u ON u.warehouse_id=b.warehouse_id::text AND u.product_id=b.product_id::text
    WHERE w.active=true AND ($1::text IS NULL OR w.location_id::text=$1)
      AND (b.quantity<=b.min_quantity OR (COALESCE(u.avg_daily_out,0)>0 AND b.quantity/u.avg_daily_out<=7))
    ORDER BY CASE WHEN b.quantity<=0 THEN 0 ELSE 1 END,days_to_zero NULLS LAST,b.quantity LIMIT 100`, [locationId]);
  const risk = rows.map((r:any)=>({...r,quantity:round(n(r.quantity),3),min_quantity:round(n(r.min_quantity),3),avg_daily_out:round(n(r.avg_daily_out),3),days_to_zero:r.days_to_zero==null?null:round(n(r.days_to_zero),1)}));
  const critical = risk.filter((r:any)=>r.quantity<=0 || (r.days_to_zero!=null && r.days_to_zero<=3));
  const severity: Severity = critical.length ? "critical" : risk.length ? "warning" : "ok";
  return { key:"stock.risk", label:"Melyik készlet fogy el?", severity, headline:critical.length?`${critical.length} kritikus készletpozíció 3 napon belüli kifogyási kockázattal`:risk.length?`${risk.length} készletpozíció figyelmet igényel`:`Nincs közeli kifogyási kockázat`, value:risk.length, evidence:{critical:critical.slice(0,20),at_risk:risk.slice(0,50)}, recommendation:critical.length?"Készíts beszerzési javaslatot a fogyási sebesség alapján; rendelést csak jóváhagyás után indíts.":"Figyeld a minimumkészletet és a 14 napos fogyási sebességet." };
}

async function locationSignal(date: string): Promise<ExecutiveSignal> {
  if (!(await tableExists("financial_movements")) || !(await tableExists("locations"))) return { key:"locations.outlier", label:"Telephelyi eltérés", severity:"unknown", headline:"Nincs hálózati összehasonlító adat", evidence:{}, recommendation:"Ellenőrizd a telephely- és pénzügyi törzsadatokat." };
  const cutoff = cutoffFor(date);
  const rows = await safeRows(`WITH current AS (
      SELECT location_id::text location_id,COALESCE(SUM(amount) FILTER(WHERE direction='income' AND cancelled_at IS NULL),0)::numeric revenue
      FROM financial_movements WHERE (occurred_at AT TIME ZONE '${TZ}')::date=$1::date AND (occurred_at AT TIME ZONE '${TZ}')::time<=$2::time GROUP BY location_id::text
    ), hist AS (
      SELECT location_id::text location_id,(occurred_at AT TIME ZONE '${TZ}')::date d,
        COALESCE(SUM(amount) FILTER(WHERE direction='income' AND cancelled_at IS NULL),0)::numeric revenue
      FROM financial_movements WHERE (occurred_at AT TIME ZONE '${TZ}')::date BETWEEN $1::date-28 AND $1::date-1
        AND (occurred_at AT TIME ZONE '${TZ}')::time<=$2::time GROUP BY location_id::text,2
    ), base AS (SELECT location_id,AVG(revenue)::numeric baseline FROM hist GROUP BY location_id)
    SELECT l.id::text location_id,l.name,COALESCE(c.revenue,0)::numeric revenue,COALESCE(b.baseline,0)::numeric baseline
    FROM locations l LEFT JOIN current c ON c.location_id=l.id::text LEFT JOIN base b ON b.location_id=l.id::text
    WHERE COALESCE(l.is_active,true)=true ORDER BY l.name`, [date, cutoff]);
  const data = rows.map((r:any)=>({location_id:r.location_id,name:r.name,revenue:round(n(r.revenue),0),baseline:round(n(r.baseline),0),delta_pct:pct(n(r.revenue),n(r.baseline))}));
  const outliers = data.filter((x:any)=>x.baseline>0 && x.delta_pct!=null && Math.abs(x.delta_pct)>=20).sort((a:any,b:any)=>Math.abs(b.delta_pct)-Math.abs(a.delta_pct));
  const critical = outliers.filter((x:any)=>x.delta_pct<=-30);
  const severity: Severity = critical.length ? "critical" : outliers.length ? "warning" : "ok";
  return { key:"locations.outlier", label:"Melyik telephely tér el az átlagtól?", severity, headline:outliers.length?`${outliers.length} telephely legalább 20%-kal eltér a saját 28 napos bázisától`:`A telephelyek forgalma a megszokott tartományban van`, value:outliers.length, evidence:{locations:data,outliers:outliers.slice(0,20)}, recommendation:critical.length?"Vizsgáld meg külön az érintett telephely foglalási volument, no-show-t, kapacitást és szolgáltatásmixet.":"A jelentős pozitív eltérések gyakorlatát is érdemes összehasonlítani." };
}

async function staffingSignal(date: string, locationId: string | null): Promise<ExecutiveSignal> {
  if (!(await tableExists("appointments"))) return { key:"staff.shortage_forecast", label:"Létszámhiány-előrejelzés", severity:"unknown", headline:"Nincs foglalási előrejelzési adat", evidence:{}, recommendation:"Ellenőrizd a következő 7 nap foglalásait és beosztását." };
  const rows = await safeRows(`WITH service_staff AS (
      SELECT COALESCE(location_id::text,'__none__') location_key,COUNT(DISTINCT employee_id)::numeric staff_count
      FROM appointments WHERE start_time>=now()-interval '60 days' AND employee_id IS NOT NULL GROUP BY 1
    ), future AS (
      SELECT (start_time AT TIME ZONE '${TZ}')::date d,COALESCE(location_id::text,'__none__') location_key,
        COALESCE(SUM(GREATEST(0,EXTRACT(EPOCH FROM (end_time-start_time))/60)) FILTER(WHERE lower(COALESCE(status,'')) NOT IN('cancelled','canceled','no_show','no-show')),0)::numeric booked_minutes,
        COUNT(*) FILTER(WHERE employee_id IS NULL)::int unassigned
      FROM appointments WHERE (start_time AT TIME ZONE '${TZ}')::date BETWEEN $1::date AND $1::date+7 GROUP BY 1,2)
    SELECT f.d,f.location_key,f.booked_minutes,f.unassigned,COALESCE(s.staff_count,0)::numeric staff_count,
      CASE WHEN COALESCE(s.staff_count,0)>0 THEN f.booked_minutes/(s.staff_count*480)*100 ELSE 0 END utilization_pct
    FROM future f LEFT JOIN service_staff s ON s.location_key=f.location_key
    WHERE ($2::text IS NULL OR f.location_key=$2) ORDER BY f.d,f.location_key`, [date, locationId]);
  const risk = rows.map((r:any)=>({date:String(r.d).slice(0,10),location_id:r.location_key,booked_minutes:round(n(r.booked_minutes),0),staff_count:round(n(r.staff_count),0),utilization_pct:round(n(r.utilization_pct),1),unassigned:n(r.unassigned)})).filter((r:any)=>r.utilization_pct>=85 || r.unassigned>0);
  const critical = risk.filter((r:any)=>r.utilization_pct>=100 || r.unassigned>=3);
  const severity: Severity = critical.length ? "critical" : risk.length ? "warning" : "ok";
  return { key:"staff.shortage_forecast", label:"Hol várható létszámhiány?", severity, headline:critical.length?`${critical.length} kritikus következő-7-napos kapacitási pont`:risk.length?`${risk.length} nap/telephely közelít a kapacitáshatárhoz`:`Nem látszik közeli foglalási alapú létszámhiány`, value:risk.length, evidence:{risk:risk.slice(0,30),method:"Foglalási percek / aktív szolgáltató munkatárs × 480 perc; beosztás hiányában közelítés."}, recommendation:risk.length?"Ellenőrizd a tényleges beosztást, szabadságokat és helyettesítési lehetőséget; a modell csak foglalási terhelésből jelez kockázatot.":"Nincs sürgős kapacitás-átszervezési jelzés." };
}

async function complaintSignal(locationId: string | null): Promise<ExecutiveSignal> {
  if (!(await tableExists("operations_quality_records"))) return { key:"complaints.urgent", label:"Sürgős panaszok", severity:"unknown", headline:"Nincs panaszforrás", evidence:{}, recommendation:"Ellenőrizd a panaszkezelési modult." };
  const rows = await safeRows(`SELECT id::text,title,description,priority,status,due_at,location_name,assignee,created_at,
      COALESCE((metadata->>'sla_days')::int,5) sla_days
    FROM operations_quality_records
    WHERE module_key='complaints' AND lower(COALESCE(status,'')) NOT IN('resolved','closed','approved','archived')
      AND ($1::text IS NULL OR metadata->>'location_id'=$1)
    ORDER BY CASE WHEN due_at<now() THEN 0 WHEN lower(priority)='critical' THEN 1 WHEN lower(priority)='high' THEN 2 ELSE 3 END,due_at NULLS LAST,created_at LIMIT 100`, [locationId]);
  const data = rows.map((r:any)=>({...r,overdue:Boolean(r.due_at && new Date(r.due_at).getTime()<Date.now()),due_within_24h:Boolean(r.due_at && new Date(r.due_at).getTime()<=Date.now()+86_400_000)}));
  const urgent = data.filter((r:any)=>r.overdue || r.due_within_24h || ["critical","high"].includes(String(r.priority||"").toLowerCase()));
  const critical = urgent.filter((r:any)=>r.overdue || String(r.priority||"").toLowerCase()==="critical");
  const severity: Severity = critical.length ? "critical" : urgent.length ? "warning" : "ok";
  return { key:"complaints.urgent", label:"Mely panasz sürgős?", severity, headline:critical.length?`${critical.length} kritikus vagy SLA-n túli panasz`:urgent.length?`${urgent.length} panasz igényel gyors vezetői figyelmet`:`Nincs sürgős nyitott panasz`, value:urgent.length, evidence:{urgent:urgent.slice(0,30)}, recommendation:urgent.length?"Rangsorold SLA, prioritás és vendéghatás szerint; az AI ne zárjon le panaszt és ne küldjön automatikus érdemi választ.":"A nyitott panaszok normál SLA szerint kezelhetők." };
}

function actionSignal(signals: ExecutiveSignal[]): ExecutiveSignal {
  const revenue = signals.find(x=>x.key==="revenue.change"), capacity=signals.find(x=>x.key==="staff.low_capacity"), noShow=signals.find(x=>x.key==="appointments.no_show"), stock=signals.find(x=>x.key==="stock.risk");
  const suggestions:string[]=[];
  if(revenue?.severity==="critical" && capacity?.severity!=="unknown") suggestions.push("Célzott üres-idősáv kampány vagy aznapi ajánlat megfontolása az alulterhelt kapacitásra.");
  if(noShow?.severity==="critical") suggestions.push("Foglalás-megerősítő / emlékeztető kommunikáció erősítése az érintett idősávokban.");
  if(stock?.severity==="critical") suggestions.push("Akció előtt zárd ki a kifogyásveszélyes termékeket és készíts beszerzési javaslatot.");
  if(!suggestions.length) suggestions.push("Nincs olyan determinisztikus eltérés, amely azonnali kampányt indokolna; tartsd a jelenlegi tervet és figyeld a trendet.");
  return { key:"marketing.action", label:"Milyen akciót érdemes indítani?", severity:suggestions.length>1?"warning":"info", headline:suggestions[0], value:suggestions.length, evidence:{suggestions}, recommendation:"Az AI csak ajánlást ad. Kampány létrehozása, célcsoport-kiválasztás és kiküldés kizárólag vezetői jóváhagyással történjen." };
}

export async function collectExecutiveSignals(date: string, locationId: string | null = null) {
  if (!validDate(date)) throw Object.assign(new Error("A dátum formátuma YYYY-MM-DD legyen."), { status:400 });
  const [revenue,noShow,capacity,stock,location,staffing,complaints] = await Promise.all([
    revenueSignal(date,locationId),noShowSignal(date,locationId),capacitySignal(date,locationId),stockSignal(locationId),locationId?Promise.resolve({key:"locations.outlier",label:"Telephelyi eltérés",severity:"info" as Severity,headline:"Telephelyszűrés aktív; hálózati összehasonlítás a teljes nézetben érhető el.",evidence:{location_id:locationId},recommendation:"Válts összes telephely nézetre a hálózati outlierekhez."}):locationSignal(date),staffingSignal(date,locationId),complaintSignal(locationId)
  ]);
  const signals:ExecutiveSignal[]=[revenue,noShow,capacity,stock,location,staffing,complaints];
  signals.splice(5,0,actionSignal(signals));
  return signals;
}

function deterministicNarrative(signals: ExecutiveSignal[], date:string) {
  const critical=signals.filter(x=>x.severity==="critical"),warning=signals.filter(x=>x.severity==="warning");
  const priority=[...critical,...warning].slice(0,5);
  const lines=[`Vezetői brief – ${date}.`,critical.length?`${critical.length} kritikus és ${warning.length} figyelmeztető jelzés van.`:warning.length?`${warning.length} figyelmeztető jelzés van; kritikus eltérés nincs.`:"Kritikus vagy figyelmeztető üzleti eltérés nem látszik."];
  for(const s of priority)lines.push(`• ${s.label}: ${s.headline}. Teendő: ${s.recommendation}`);
  lines.push("A rendszer elemző üzemmódban működik: nem indít kampányt, nem módosít beosztást, nem rendel készletet és nem zár le panaszt automatikusan.");
  return lines.join("\n");
}

async function aiBudgetAvailable() {
  const max=Number(process.env.EXECUTIVE_AI_MONTHLY_BUDGET_USD||5);
  if(!(max>0)||!(await tableExists("ai_usage_log")))return true;
  const row=(await safeRows(`SELECT COALESCE(SUM(estimated_cost_usd),0)::numeric cost FROM ai_usage_log WHERE user_key=$1 AND created_at>=date_trunc('month',now())`,[AI_USER_KEY]))[0];
  return n(row?.cost)<max;
}

async function generateAiNarrative(signals:ExecutiveSignal[],date:string,locationId:string|null,question?:string) {
  const apiKey=process.env.OPENAI_API_KEY;
  if(!apiKey||!(await aiBudgetAvailable()))return {used:false,text:deterministicNarrative(signals,date)};
  const instructions=`Te a Kleopátra VIR vezetői elemző asszisztense vagy. Kizárólag a kapott, determinisztikusan kiszámított üzleti adatokból dolgozz. Ne találj ki KPI-t vagy ok-okozati bizonyosságot. Különítsd el a tényt, a valószínű magyarázatot és a javaslatot. Magyarul, tömören írj. Nem vagy autonóm döntéshozó: ne állítsd, hogy kampányt indítottál, beosztást módosítottál, készletet rendeltél, dolgozót értékeltél vagy panaszt lezártál. Az érzékeny HR következtetéseket kezeld óvatosan; az alacsony kapacitás önmagában nem teljesítményminősítés.`;
  const prompt=question?`Vezetői kérdés: ${String(question).slice(0,1000)}\n\nDátum: ${date}\nTelephely: ${locationId||"összes"}\nAdatok:\n${JSON.stringify(signals)}`:`Készíts vezetői briefet az alábbi adatokból. Prioritás: mi változott, miért történhetett, mi igényel döntést ma, mi várható a következő 7 napban, és milyen akciót érdemes megfontolni.\nDátum: ${date}\nTelephely: ${locationId||"összes"}\nAdatok:\n${JSON.stringify(signals)}`;
  try{
    const response=await axios.post("https://api.openai.com/v1/responses",{model:process.env.OPENAI_MODEL||"gpt-5-mini",instructions,input:prompt,store:false,max_output_tokens:1200},{headers:{Authorization:`Bearer ${apiKey}`,"Content-Type":"application/json"},timeout:45_000});
    const data:any=response.data;let text=String(data?.output_text||"").trim();
    if(!text&&Array.isArray(data?.output))text=data.output.flatMap((x:any)=>x?.content||[]).filter((x:any)=>x?.type==="output_text").map((x:any)=>x.text).join("\n").trim();
    if(!text)return {used:false,text:deterministicNarrative(signals,date)};
    if(await tableExists("ai_usage_log")){
      const inputTokens=n(data?.usage?.input_tokens),outputTokens=n(data?.usage?.output_tokens);
      const inputCost=Number(process.env.OPENAI_INPUT_USD_PER_1M||0.25),outputCost=Number(process.env.OPENAI_OUTPUT_USD_PER_1M||2);
      const cost=inputTokens/1_000_000*inputCost+outputTokens/1_000_000*outputCost;
      await db.query(`INSERT INTO ai_usage_log(user_key,model,input_tokens,output_tokens,estimated_cost_usd) VALUES($1,$2,$3,$4,$5)`,[AI_USER_KEY,data?.model||process.env.OPENAI_MODEL||"gpt-5-mini",inputTokens,outputTokens,cost]).catch(()=>undefined);
    }
    return {used:true,text};
  }catch(error:any){console.error("[executive-ai] OpenAI narrative failed",error?.response?.status||"",error?.message||error);return {used:false,text:deterministicNarrative(signals,date)};}
}

async function writeDelivery(alertKey:string,recipient:string,status:"sent"|"failed"|"logged",errorText?:string|null){
  await db.query(`INSERT INTO executive_ai_alert_deliveries(alert_key,recipient,status,error_text) VALUES($1,$2,$3,$4)`,[alertKey,recipient,status,errorText?String(errorText).slice(0,1500):null]);
}
async function notifyCritical(alertKey:string,title:string,detail:string){
  const recipients=await getApmAdminRecipients();
  if(!recipients.length){await writeDelivery(alertKey,"unconfigured-admin-recipient","logged","Nincs admin e-mail cím konfigurálva.");return;}
  for(const recipient of recipients){
    try{const result:any=await sendEmail({to:recipient,subject:`[CRITICAL] VIR vezetői asszisztens – ${title}`,text:`Kritikus vezetői jelzés\n\n${detail}\n\nA VIR AI vezetői asszisztens elemző jelzése. A rendszer nem hajtott végre autonóm üzleti műveletet.`});await writeDelivery(alertKey,recipient,result?.sent?"sent":"logged",result?.sent?null:"SMTP nem küldött; az üzenet naplózva lett.");}
    catch(error:any){await writeDelivery(alertKey,recipient,"failed",error?.message||String(error));}
  }
}

async function syncCriticalAlerts(date:string,locationId:string|null,signals:ExecutiveSignal[]){
  const key=locationKey(locationId),critical=signals.filter(x=>x.severity==="critical");
  const activeKeys=critical.map(x=>`executive:${date}:${key}:${x.key}`);
  await db.query(`UPDATE executive_ai_alert_events SET resolved_at=COALESCE(resolved_at,now()),last_seen_at=now()
    WHERE business_date=$1 AND location_key=$2 AND resolved_at IS NULL AND NOT(alert_key=ANY($3::text[]))`,[date,key,activeKeys]).catch(()=>undefined);
  for(const signal of critical){
    const alertKey=`executive:${date}:${key}:${signal.key}`;
    const previous=(await db.query(`SELECT last_notified_at FROM executive_ai_alert_events WHERE alert_key=$1`,[alertKey])).rows[0];
    await db.query(`INSERT INTO executive_ai_alert_events(alert_key,business_date,location_key,signal_key,title,detail)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(alert_key) DO UPDATE SET severity='critical',title=EXCLUDED.title,detail=EXCLUDED.detail,last_seen_at=now(),resolved_at=NULL,occurrences=executive_ai_alert_events.occurrences+1`,[alertKey,date,key,signal.key,signal.label,`${signal.headline}\n${signal.recommendation}`]);
    const last=previous?.last_notified_at?new Date(previous.last_notified_at).getTime():0;
    if(!last||Date.now()-last>=ALERT_COOLDOWN_MINUTES*60_000){await notifyCritical(alertKey,signal.label,`${signal.headline}\nTeendőjavaslat: ${signal.recommendation}`);await db.query(`UPDATE executive_ai_alert_events SET last_notified_at=now() WHERE alert_key=$1`,[alertKey]);}
  }
}

export async function runExecutiveBrief(date=currentBudapestDate(),locationId:string|null=null,options:{runType?:string;persist?:boolean;notify?:boolean;useAi?:boolean}={}) : Promise<ExecutiveBrief> {
  await ensureExecutiveAiSchema();
  const signals=await collectExecutiveSignals(date,locationId);
  const critical=signals.filter(x=>x.severity==="critical").length,warning=signals.filter(x=>x.severity==="warning").length;
  const status:"ok"|"warning"|"critical"=critical?"critical":warning?"warning":"ok";
  const ai=options.useAi===false?{used:false,text:deterministicNarrative(signals,date)}:await generateAiNarrative(signals,date,locationId);
  const recommendations=[...new Set(signals.filter(x=>["critical","warning"].includes(x.severity)).map(x=>x.recommendation))];
  const brief:ExecutiveBrief={business_date:date,location_id:locationId,run_type:options.runType||"manual",status,generated_at:new Date().toISOString(),ai_used:ai.used,narrative:ai.text,signals,recommendations};
  if(options.persist!==false){await db.query(`INSERT INTO executive_ai_briefs(business_date,location_key,run_type,status,ai_used,narrative,signals,recommendations,generated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,now()) ON CONFLICT(business_date,location_key,run_type) DO UPDATE SET status=EXCLUDED.status,ai_used=EXCLUDED.ai_used,narrative=EXCLUDED.narrative,signals=EXCLUDED.signals,recommendations=EXCLUDED.recommendations,generated_at=now()`,[date,locationKey(locationId),brief.run_type,status,brief.ai_used,brief.narrative,JSON.stringify(signals),JSON.stringify(recommendations)]);}
  if(options.notify!==false)await syncCriticalAlerts(date,locationId,signals);
  return brief;
}

export async function askExecutiveAssistant(question:string,date=currentBudapestDate(),locationId:string|null=null){
  const q=String(question||"").trim();if(!q)throw Object.assign(new Error("A vezetői kérdés nem lehet üres."),{status:400});
  const signals=await collectExecutiveSignals(date,locationId);const ai=await generateAiNarrative(signals,date,locationId,q);
  return {business_date:date,location_id:locationId,question:q,answer:ai.text,ai_used:ai.used,signals};
}

async function scheduledRun(runType:string){
  try{await runExecutiveBrief(currentBudapestDate(),null,{runType,persist:true,notify:true,useAi:true});}
  catch(error:any){console.error(`[executive-ai] ${runType} run failed`,error?.message||error);}
}
export function startExecutiveAiScheduler(){
  if(schedulerStarted||process.env.EXECUTIVE_AI_DISABLED==="1"||process.env.NODE_ENV==="test")return;
  schedulerStarted=true;
  cron.schedule("10 8 * * *",()=>void scheduledRun("morning"),{timezone:TZ});
  cron.schedule("10 13 * * *",()=>void scheduledRun("midday"),{timezone:TZ});
  cron.schedule("10 20 * * *",()=>void scheduledRun("close"),{timezone:TZ});
  console.log("[executive-ai] automated briefs scheduled 08:10, 13:10 and 20:10 Europe/Budapest");
}
