import express from "express";
import pool from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";
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

async function loadDashboard(from: string, to: string, locationId: any, isAdmin: boolean, now: Date) {
  await ensureDashboardAnalytics();
  const params = [from, to, locationId];
  const filter = `f.fact_date BETWEEN $1::date AND $2::date AND ($3::uuid IS NULL OR f.location_id=$3::uuid)`;

  // Maximum 4 analytics query fut egyszerre: a 10 kapcsolatos alap poolból marad
  // kapacitás a menünek, jogosultságnak, időpontoknak és egyéb kezdőképernyős kéréseknek.
  const [summaryRes, trendRes, locationRes, positionRes] = await Promise.all([
    pool.query(`
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
    pool.query(`
      WITH days AS (SELECT generate_series($1::date,$2::date,'1 day')::date AS fact_day)
      SELECT d.fact_day::text date,
        COALESCE(SUM(f.service_revenue+f.product_revenue),0)::numeric revenue,
        COALESCE(SUM(f.service_revenue),0)::numeric service_revenue,
        COALESCE(SUM(f.product_revenue),0)::numeric product_revenue,
        COALESCE(SUM(f.completed_count),0)::int completed
      FROM days d LEFT JOIN management_daily_facts f ON f.fact_date=d.fact_day AND ($3::uuid IS NULL OR f.location_id=$3::uuid)
      GROUP BY d.fact_day ORDER BY d.fact_day`, params),
    pool.query(`
      SELECT l.id,l.name,
        SUM(f.service_revenue+f.product_revenue)::numeric revenue,
        SUM(f.service_revenue)::numeric service_revenue,
        SUM(f.product_revenue)::numeric product_revenue,
        SUM(f.completed_count)::int completed,
        ROUND(100.0*SUM(f.productive_minutes)/NULLIF(SUM(f.available_minutes),0),1)::numeric capacity,
        ROUND(100.0*SUM(f.no_show_count)/NULLIF(SUM(f.appointment_count),0),1)::numeric no_show_rate
      FROM management_daily_facts f JOIN locations l ON l.id=f.location_id
      WHERE ${filter} GROUP BY l.id,l.name ORDER BY revenue DESC`, params),
    pool.query(`
      SELECT COALESCE(p.name,'Nincs munkakör') position_name,
        SUM(f.service_revenue+f.product_revenue)::numeric revenue,
        SUM(f.service_revenue)::numeric service_revenue,
        SUM(f.product_revenue)::numeric product_revenue,
        SUM(f.completed_count)::int completed,
        ROUND(SUM(f.service_revenue+f.product_revenue)/NULLIF(SUM(f.productive_minutes)/60.0,0),0)::numeric revenue_per_hour,
        ROUND(100.0*SUM(f.productive_minutes)/NULLIF(SUM(f.available_minutes),0),1)::numeric capacity
      FROM management_daily_facts f LEFT JOIN hr_positions p ON p.id=f.position_id
      WHERE ${filter} GROUP BY p.id,p.name ORDER BY revenue DESC`, params),
  ]);

  const [staffRes, absenceRes, clientsRes, availableLocationsRes] = await Promise.all([
    pool.query(`
      SELECT e.id,e.full_name,COALESCE(p.name,'Nincs munkakör') position_name,l.name location_name,
        SUM(f.service_revenue+f.product_revenue)::numeric revenue,
        SUM(f.completed_count)::int completed,
        ROUND(100.0*SUM(f.productive_minutes)/NULLIF(SUM(f.available_minutes),0),1)::numeric capacity
      FROM management_daily_facts f JOIN employees e ON e.id=f.employee_id
      JOIN locations l ON l.id=f.location_id LEFT JOIN hr_positions p ON p.id=f.position_id
      WHERE ${filter} GROUP BY e.id,e.full_name,p.name,l.name ORDER BY revenue DESC LIMIT 10`, params),
    pool.query(`
      SELECT COALESCE(p.name,'Nincs munkakör') position_name,
        ROUND(SUM(f.sick_minutes)/480.0,1)::numeric sick_days,
        ROUND(SUM(f.paid_leave_minutes)/480.0,1)::numeric paid_leave_days,
        ROUND(SUM(f.unpaid_leave_minutes)/480.0,1)::numeric unpaid_leave_days,
        ROUND(SUM(f.unexcused_minutes)/480.0,1)::numeric unexcused_days,
        ROUND(100.0*SUM(f.sick_minutes+f.paid_leave_minutes+f.unpaid_leave_minutes+f.unexcused_minutes)/NULLIF(SUM(f.available_minutes),0),1)::numeric absence_rate
      FROM management_daily_facts f LEFT JOIN hr_positions p ON p.id=f.position_id
      WHERE ${filter} GROUP BY p.id,p.name
      HAVING SUM(f.sick_minutes+f.paid_leave_minutes+f.unpaid_leave_minutes+f.unexcused_minutes)>0
      ORDER BY absence_rate DESC`, params),
    pool.query(`SELECT COUNT(*)::int total_clients FROM clients`),
    pool.query(`SELECT id,name FROM locations WHERE ($1::boolean OR id=$2::uuid) ORDER BY name`, [isAdmin, locationId]),
  ]);

  const summary = summaryRes.rows[0] || {};
  const todayRevenue = trendRes.rows.find((row: any) => row.date === now.toISOString().slice(0,10))?.revenue || 0;
  const alerts: Array<{level:string;title:string;detail:string}> = [];
  if (Number(summary.no_show_rate) >= 5) alerts.push({level:"warning",title:"Magas meg nem jelenési arány",detail:`${summary.no_show_rate}% az időszakban`});
  if (Number(summary.average_capacity) < 60) alerts.push({level:"info",title:"Kihasználatlan kapacitás",detail:`Átlagosan ${summary.average_capacity}% a foglaltság`});
  if (Number(summary.unexcused_days) > 0) alerts.push({level:"critical",title:"Igazolatlan hiányzás",detail:`${Number(summary.unexcused_days).toFixed(1)} munkanap`});

  return {
    period:{from,to},
    stats:{
      dailyRevenue:Number(todayRevenue), monthlyRevenue:Number(summary.total_revenue||0), totalRevenue:Number(summary.total_revenue||0),
      serviceRevenue:Number(summary.service_revenue||0), productRevenue:Number(summary.product_revenue||0),
      averageInvoice:Number(summary.average_invoice||0), averageServiceInvoice:Number(summary.average_service_invoice||0),
      averageCapacity:Number(summary.average_capacity||0), totalClients:Number(clientsRes.rows[0]?.total_clients||0),
      newClients:Number(summary.new_clients||0), activeAppointments:Number(summary.appointment_count||0),
      completedAppointments:Number(summary.completed_count||0), cancelledAppointments:Number(summary.cancelled_count||0),
      noShowCount:Number(summary.no_show_count||0), completionRate:Number(summary.completion_rate||0),
      noShowRate:Number(summary.no_show_rate||0), sickDays:Number(summary.sick_days||0),
      leaveDays:Number(summary.leave_days||0), unexcusedDays:Number(summary.unexcused_days||0), lowStockCount:0
    },
    chartData:trendRes.rows,
    revenueByLocation:locationRes.rows,
    revenueByPosition:positionRes.rows,
    topEmployees:staffRes.rows,
    absenceByPosition:absenceRes.rows,
    locations:availableLocationsRes.rows,
    alerts
  };
}

router.get("/", requireAuth, async (req: AuthRequest, res) => {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - 29);
  const from = isoDate(req.query.from, start);
  const to = isoDate(req.query.to, now);
  const roles = roleKeys(req.user?.role);
  const isAdmin = roles.includes("admin");
  const requestedLocation = String(req.query.location_id || "").trim() || null;
  const locationId = isAdmin ? requestedLocation : (req.user?.location_id || null);
  const cacheKey = `dashboard:${scopedCacheKey([from,to,locationId,isAdmin,roles.sort().join(",")])}`;

  try {
    const payload = await shortCache(cacheKey, DASHBOARD_CACHE_MS, () =>
      timed(`/api/dashboard ${from}..${to} ${locationId || "all"}`, () => loadDashboard(from,to,locationId,isAdmin,now)),
    );
    res.setHeader("Cache-Control", "private, no-store");
    return res.json(payload);
  } catch (err:any) {
    console.error("❌ /api/dashboard vezetői lekérdezési hiba:", err);
    return res.status(500).json({error:"A vezetői kimutatások betöltése nem sikerült.",detail:err?.message||String(err)});
  }
});

export default router;
