import express from "express";
import pool from "../db";
import { AuthRequest } from "../middleware/auth";
import { ensureDashboardAnalytics } from "../dashboard/ensureDashboardAnalytics";
import { scheduleDashboardWarmup } from "../performance/dashboardWarmup";
import { scopedCacheKey } from "../performance/cacheKey";
import { shortCache, timed } from "../performance/shortCache";

const router = express.Router();
const DASHBOARD_CACHE_MS = Number(process.env.DASHBOARD_CACHE_MS ?? 20000);
scheduleDashboardWarmup();

const isoDate = (value: unknown, fallback: Date) => {
  const text = String(value || "");
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : fallback.toISOString().slice(0, 10);
};

const roleKeys = (role: unknown): string[] => {
  if (Array.isArray(role)) return role.map(String).map(x => x.toLowerCase());
  try {
    const parsed = JSON.parse(String(role || ""));
    if (Array.isArray(parsed)) return parsed.map(String).map(x => x.toLowerCase());
  } catch { /* legacy text role */ }
  return String(role || "").split(",").map(x => x.replace(/[\[\]"]/g, "").trim().toLowerCase()).filter(Boolean);
};

type SafeRows = { rows: any[]; error: string | null };

async function safeRows(label: string, sql: string, params: any[]): Promise<SafeRows> {
  try {
    const result = await pool.query(sql, params);
    return { rows: result.rows, error: null };
  } catch (error: any) {
    const message = error?.message || String(error);
    console.warn(`[dashboard] lekérdezés kihagyva (${label}):`, message);
    return { rows: [], error: message };
  }
}

async function optionalRows(label: string, sql: string, params: any[]): Promise<any[]> {
  return (await safeRows(label, sql, params)).rows;
}

function emptyTrend(from: string, to: string) {
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) return [];
  const rows: any[] = [];
  for (let cursor = new Date(start), guard = 0; cursor <= end && guard < 370; cursor.setUTCDate(cursor.getUTCDate() + 1), guard += 1) {
    rows.push({date: cursor.toISOString().slice(0, 10), revenue: 0, service_revenue: 0, product_revenue: 0, completed: 0});
  }
  return rows;
}

async function loadDashboard(from: string, to: string, locationId: any, isAdmin: boolean, tenantId: string, now: Date) {
  let analyticsBootstrapError: string | null = null;
  try {
    await ensureDashboardAnalytics();
  } catch (error: any) {
    analyticsBootstrapError = error?.message || String(error);
    console.warn("[dashboard] analytics bootstrap nem sikerült; degradált dashboard folytatódik:", analyticsBootstrapError);
  }

  const params = [from, to, locationId, tenantId];
  const tenantFact = `EXISTS (
    SELECT 1 FROM locations tl
    WHERE tl.id::text=f.location_id::text
      AND COALESCE(to_jsonb(tl)->>'tenant_id','')=$4::text
  )`;
  const filter = `f.fact_date BETWEEN $1::date AND $2::date
    AND ($3::text IS NULL OR f.location_id::text=$3::text)
    AND ${tenantFact}`;

  const [summaryResult, trendResult] = await Promise.all([
    safeRows("summary", `
      SELECT
        COALESCE(SUM(service_revenue+product_revenue),0)::numeric total_revenue,
        COALESCE(SUM(service_revenue),0)::numeric service_revenue,
        COALESCE(SUM(product_revenue),0)::numeric product_revenue,
        COALESCE(SUM(invoice_count),0)::int invoice_count,
        COALESCE(SUM(appointment_count),0)::int appointment_count,
        COALESCE(SUM(completed_count),0)::int completed_count,
        COALESCE(SUM(cancelled_count),0)::int cancelled_count,
        COALESCE(SUM(no_show_count),0)::int no_show_count,
        COALESCE(SUM(new_client_count),0)::int new_clients,
        COALESCE(ROUND(SUM(service_revenue+product_revenue)/NULLIF(SUM(invoice_count),0),0),0)::numeric average_invoice,
        COALESCE(ROUND(SUM(service_revenue)/NULLIF(SUM(invoice_count),0),0),0)::numeric average_service_invoice,
        COALESCE(ROUND(100.0*SUM(productive_minutes)/NULLIF(SUM(available_minutes),0),1),0)::numeric average_capacity,
        COALESCE(ROUND(100.0*SUM(completed_count)/NULLIF(SUM(appointment_count),0),1),0)::numeric completion_rate,
        COALESCE(ROUND(100.0*SUM(no_show_count)/NULLIF(SUM(appointment_count),0),1),0)::numeric no_show_rate,
        COALESCE(SUM(sick_minutes)/480.0,0)::numeric sick_days,
        COALESCE(SUM(paid_leave_minutes+unpaid_leave_minutes)/480.0,0)::numeric leave_days,
        COALESCE(SUM(unexcused_minutes)/480.0,0)::numeric unexcused_days
      FROM management_daily_facts f WHERE ${filter}`, params),
    safeRows("trend", `
      WITH days AS (SELECT generate_series($1::date,$2::date,'1 day')::date AS fact_day)
      SELECT d.fact_day::text date,
        COALESCE(SUM(f.service_revenue+f.product_revenue),0)::numeric revenue,
        COALESCE(SUM(f.service_revenue),0)::numeric service_revenue,
        COALESCE(SUM(f.product_revenue),0)::numeric product_revenue,
        COALESCE(SUM(f.completed_count),0)::int completed
      FROM days d LEFT JOIN management_daily_facts f
        ON f.fact_date=d.fact_day
       AND ($3::text IS NULL OR f.location_id::text=$3::text)
       AND EXISTS (
         SELECT 1 FROM locations tl
         WHERE tl.id::text=f.location_id::text
           AND COALESCE(to_jsonb(tl)->>'tenant_id','')=$4::text
       )
      GROUP BY d.fact_day ORDER BY d.fact_day`, params),
  ]);

  const [locationRows, positionRows, staffRows, absenceRows, clientRows, availableLocationRows] = await Promise.all([
    optionalRows("location", `
      SELECT l.id,l.name,
        SUM(f.service_revenue+f.product_revenue)::numeric revenue,
        SUM(f.service_revenue)::numeric service_revenue,
        SUM(f.product_revenue)::numeric product_revenue,
        SUM(f.completed_count)::int completed,
        ROUND(100.0*SUM(f.productive_minutes)/NULLIF(SUM(f.available_minutes),0),1)::numeric capacity,
        ROUND(100.0*SUM(f.no_show_count)/NULLIF(SUM(f.appointment_count),0),1)::numeric no_show_rate
      FROM management_daily_facts f JOIN locations l ON l.id::text=f.location_id::text
      WHERE ${filter} AND COALESCE(to_jsonb(l)->>'tenant_id','')=$4::text
      GROUP BY l.id,l.name ORDER BY revenue DESC`, params),
    optionalRows("position", `
      SELECT COALESCE(p.name,'Nincs munkakör') position_name,
        SUM(f.service_revenue+f.product_revenue)::numeric revenue,
        SUM(f.service_revenue)::numeric service_revenue,
        SUM(f.product_revenue)::numeric product_revenue,
        SUM(f.completed_count)::int completed,
        ROUND(SUM(f.service_revenue+f.product_revenue)/NULLIF(SUM(f.productive_minutes)/60.0,0),0)::numeric revenue_per_hour,
        ROUND(100.0*SUM(f.productive_minutes)/NULLIF(SUM(f.available_minutes),0),1)::numeric capacity
      FROM management_daily_facts f LEFT JOIN hr_positions p ON p.id::text=f.position_id::text
      WHERE ${filter} GROUP BY p.id,p.name ORDER BY revenue DESC`, params),
    optionalRows("staff", `
      SELECT e.id,e.full_name,COALESCE(p.name,'Nincs munkakör') position_name,l.name location_name,
        SUM(f.service_revenue+f.product_revenue)::numeric revenue,
        SUM(f.completed_count)::int completed,
        ROUND(100.0*SUM(f.productive_minutes)/NULLIF(SUM(f.available_minutes),0),1)::numeric capacity
      FROM management_daily_facts f JOIN employees e ON e.id::text=f.employee_id::text
      JOIN locations l ON l.id::text=f.location_id::text LEFT JOIN hr_positions p ON p.id::text=f.position_id::text
      WHERE ${filter} AND COALESCE(to_jsonb(l)->>'tenant_id','')=$4::text
      GROUP BY e.id,e.full_name,p.name,l.name ORDER BY revenue DESC LIMIT 10`, params),
    optionalRows("absence", `
      SELECT COALESCE(p.name,'Nincs munkakör') position_name,
        ROUND(SUM(f.sick_minutes)/480.0,1)::numeric sick_days,
        ROUND(SUM(f.paid_leave_minutes)/480.0,1)::numeric paid_leave_days,
        ROUND(SUM(f.unpaid_leave_minutes)/480.0,1)::numeric unpaid_leave_days,
        ROUND(SUM(f.unexcused_minutes)/480.0,1)::numeric unexcused_days,
        ROUND(100.0*SUM(f.sick_minutes+f.paid_leave_minutes+f.unpaid_leave_minutes+f.unexcused_minutes)/NULLIF(SUM(f.available_minutes),0),1)::numeric absence_rate
      FROM management_daily_facts f LEFT JOIN hr_positions p ON p.id::text=f.position_id::text
      WHERE ${filter} GROUP BY p.id,p.name
      HAVING SUM(f.sick_minutes+f.paid_leave_minutes+f.unpaid_leave_minutes+f.unexcused_minutes)>0
      ORDER BY absence_rate DESC`, params),
    optionalRows("clients", `
      SELECT COUNT(*)::int total_clients
      FROM clients c
      WHERE COALESCE(to_jsonb(c)->>'tenant_id','')=$1::text`, [tenantId]),
    optionalRows("locations", `
      SELECT l.id,l.name FROM locations l
      WHERE COALESCE(to_jsonb(l)->>'tenant_id','')=$1::text
        AND ($2::boolean OR l.id::text=$3::text)
      ORDER BY l.name`, [tenantId, isAdmin, locationId]),
  ]);

  const summary = summaryResult.rows[0] || {};
  const chartData = trendResult.rows.length ? trendResult.rows : emptyTrend(from, to);
  const todayRevenue = chartData.find((row: any) => row.date === now.toISOString().slice(0,10))?.revenue || 0;
  const analyticsDegraded = Boolean(analyticsBootstrapError || summaryResult.error || trendResult.error);
  const alerts: Array<{level:string;title:string;detail:string}> = [];
  if (analyticsDegraded) alerts.push({level:"warning",title:"Vezetői analitika korlátozott",detail:"Az analitikai ténytár átmenetileg nem elérhető; az irányítópult többi része tovább használható."});
  if (Number(summary.no_show_rate) >= 5) alerts.push({level:"warning",title:"Magas meg nem jelenési arány",detail:`${summary.no_show_rate}% az időszakban`});
  if (!analyticsDegraded && Number(summary.average_capacity) < 60) alerts.push({level:"info",title:"Kihasználatlan kapacitás",detail:`Átlagosan ${summary.average_capacity}% a foglaltság`});
  if (Number(summary.unexcused_days) > 0) alerts.push({level:"critical",title:"Igazolatlan hiányzás",detail:`${Number(summary.unexcused_days).toFixed(1)} munkanap`});

  return {
    period:{from,to},
    analytics:{available:!analyticsDegraded,degraded:analyticsDegraded},
    stats:{
      dailyRevenue:Number(todayRevenue), monthlyRevenue:Number(summary.total_revenue||0), totalRevenue:Number(summary.total_revenue||0),
      serviceRevenue:Number(summary.service_revenue||0), productRevenue:Number(summary.product_revenue||0),
      averageInvoice:Number(summary.average_invoice||0), averageServiceInvoice:Number(summary.average_service_invoice||0),
      averageCapacity:Number(summary.average_capacity||0), totalClients:Number(clientRows[0]?.total_clients||0),
      newClients:Number(summary.new_clients||0), activeAppointments:Number(summary.appointment_count||0),
      completedAppointments:Number(summary.completed_count||0), cancelledAppointments:Number(summary.cancelled_count||0),
      noShowCount:Number(summary.no_show_count||0), completionRate:Number(summary.completion_rate||0),
      noShowRate:Number(summary.no_show_rate||0), sickDays:Number(summary.sick_days||0),
      leaveDays:Number(summary.leave_days||0), unexcusedDays:Number(summary.unexcused_days||0), lowStockCount:0
    },
    chartData,
    revenueByLocation:locationRows,
    revenueByPosition:positionRows,
    topEmployees:staffRows,
    absenceByPosition:absenceRows,
    locations:availableLocationRows,
    alerts
  };
}

// Authentication and tenant/location authorization are guaranteed by the
// locationManagerScope("dashboard") middleware at the /api/dashboard mount.
// Do not re-run requireAuth here: a second JWT decode can overwrite the tenant
// context that the scope middleware just resolved from the database.
router.get("/", async (req: AuthRequest, res) => {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - 29);
  const from = isoDate(req.query.from, start);
  const to = isoDate(req.query.to, now);
  const roles = roleKeys(req.user?.role);
  const isAdmin = roles.includes("admin");
  const requestedLocation = String(req.query.location_id || "").trim() || null;
  const locationId = isAdmin ? requestedLocation : (req.user?.location_id || null);
  const authUser = req.user as (NonNullable<AuthRequest["user"]> & { tenant_id?: string | number | null }) | undefined;
  const tenantId = authUser?.tenant_id == null ? "" : String(authUser.tenant_id);
  if (!tenantId) return res.status(403).json({error:"A dashboardhoz nincs aktív tenant-környezet.",code:"TENANT_ACCESS_DENIED"});
  const cacheKey = `dashboard:${scopedCacheKey([from,to,locationId,isAdmin,tenantId,roles.sort().join(",")])}`;

  try {
    const payload = await shortCache(cacheKey, DASHBOARD_CACHE_MS, () =>
      timed(`/api/dashboard ${from}..${to} ${locationId || "all"} tenant=${tenantId}`, () => loadDashboard(from,to,locationId,isAdmin,tenantId,now)),
    );
    res.setHeader("Cache-Control", "private, no-store");
    return res.json(payload);
  } catch (err:any) {
    console.error("❌ /api/dashboard vezetői lekérdezési hiba:", err);
    return res.status(500).json({error:"A vezetői kimutatások betöltése nem sikerült.",detail:err?.message||String(err)});
  }
});

export default router;
