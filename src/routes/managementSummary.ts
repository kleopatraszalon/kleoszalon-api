import { Router } from "express";
import db from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { requireFeature } from "../middleware/featureAccess";
import { scopedCacheKey } from "../performance/cacheKey";
import { shortCache, timed } from "../performance/shortCache";

const router = Router();
router.use(requireAuth);
router.use(requireFeature("management_dashboard"));
const MANAGEMENT_CACHE_MS = Number(process.env.MANAGEMENT_SUMMARY_CACHE_MS ?? 15000);
const n = (v: unknown) => Number(v || 0);
const emptyRevenue = { service_revenue:0, product_revenue:0, gross_revenue:0, discounts:0, tips:0, closed_workorders:0, service_quantity:0, product_quantity:0 };
const emptyStock = { inventory_value:0, low_stock_count:0, out_of_stock_count:0, stocked_products:0 };
const emptyCrm = { visits:0, unique_guests:0, guest_revenue:0, avg_guest_spend:0 };
const emptyGuestSegments = { new_guests:0, returning_guests:0, inactive_guests:0 };

function roleKeys(req: AuthRequest): string[] {
  const raw:any=req.user?.role;
  if(Array.isArray(raw)) return raw.map(String).map(x=>x.toLowerCase());
  try { const p=JSON.parse(String(raw||"")); if(Array.isArray(p)) return p.map(String).map(x=>x.toLowerCase()); } catch {}
  return String(raw||"").replace(/[\[\]"]/g,"").split(",").map(x=>x.trim().toLowerCase()).filter(Boolean);
}

async function canViewFinancial(req: AuthRequest) {
  const roles=roleKeys(req);
  if(roles.includes("admin")) return true;
  try {
    const { rows } = await db.query(`SELECT p.can_view_financial
      FROM role_menu_permissions p JOIN menus m ON m.id=p.menu_id
      WHERE p.role_key=ANY($1::text[]) AND m.code IN ('analytics','analytics.main','dashboard')`,[roles]);
    if(!rows.length) return true;
    return rows.some((r:any)=>r.can_view_financial===true);
  } catch(err:any) {
    if(["42P01","42703"].includes(String(err?.code||""))) return true;
    throw err;
  }
}

async function safeQuery(sql:string, params:any[], fallback:any, source:string, warnings:string[]) {
  try { return await db.query(sql, params); }
  catch (err:any) {
    if (["42P01","42703","42883"].includes(String(err?.code || ""))) {
      console.warn(`management-summary ${source} unavailable:`, err.message);
      warnings.push(`${source}: ${err.message}`);
      return { rows: [fallback] } as any;
    }
    throw err;
  }
}
async function safeRows(sql:string,params:any[],source:string,warnings:string[]) {
  try { return (await db.query(sql,params)).rows as any[]; }
  catch(err:any) {
    if(["42P01","42703","42883","42804"].includes(String(err?.code||""))) {
      console.warn(`management BI ${source} unavailable:`,err.message);
      warnings.push(`${source}: ${err.message}`);
      return [];
    }
    throw err;
  }
}

async function loadStock(financialVisible:boolean, locationId:string|null, warnings:string[]) {
  try {
    return await db.query(`SELECT ${financialVisible?"COALESCE(SUM(b.quantity*COALESCE(b.unit_cost,0)),0)::numeric":"0::numeric"} inventory_value,
      COUNT(*) FILTER(WHERE b.quantity>0 AND b.quantity<=COALESCE(b.min_quantity,0))::int low_stock_count,
      COUNT(*) FILTER(WHERE b.quantity<=0)::int out_of_stock_count,COUNT(*) FILTER(WHERE b.quantity>0)::int stocked_products
      FROM product_stock_balances b WHERE ($1::text IS NULL OR b.location_id::text=$1::text)`,[locationId]);
  } catch(err:any) {
    if (String(err?.code)==="42703") {
      warnings.push(`készlet: unit_cost/min_quantity még nincs migrálva`);
      return safeQuery(`SELECT 0::numeric inventory_value,0::int low_stock_count,
        COUNT(*) FILTER(WHERE b.quantity<=0)::int out_of_stock_count,COUNT(*) FILTER(WHERE b.quantity>0)::int stocked_products
        FROM product_stock_balances b WHERE ($1::text IS NULL OR b.location_id::text=$1::text)`,[locationId],emptyStock,"készlet",warnings);
    }
    if (String(err?.code)==="42P01") { warnings.push(`készlet: tábla még nincs migrálva`); return {rows:[emptyStock]} as any; }
    throw err;
  }
}

async function buildSummary(from:string,to:string,locationId:string|null,financialVisible:boolean) {
  const params:any[] = [from,to,locationId];
  const loc = `($3::text IS NULL OR wo.location_id::text=$3::text)`;
  const warnings:string[] = [];
  const [revenueRes, stockRes, crmRes, guestSegmentsRes, staffRes] = await Promise.all([
    financialVisible ? safeQuery(`WITH closed AS (
      SELECT wo.id,wo.employee_id,wo.location_id,COALESCE(wo.discount_amount,0) discount_amount,COALESCE(wo.tip_amount,0) tip_amount,
        COALESCE(SUM(CASE WHEN wi.item_type='service' THEN wi.line_total ELSE 0 END),0)::numeric service_revenue,
        COALESCE(SUM(CASE WHEN wi.item_type='product' THEN wi.line_total ELSE 0 END),0)::numeric product_revenue,
        COALESCE(SUM(CASE WHEN wi.item_type='service' THEN wi.quantity ELSE 0 END),0)::numeric service_quantity,
        COALESCE(SUM(CASE WHEN wi.item_type='product' THEN wi.quantity ELSE 0 END),0)::numeric product_quantity
      FROM work_orders wo LEFT JOIN work_order_items wi ON wi.work_order_id=wo.id
      WHERE wo.financial_closed_at::date BETWEEN $1::date AND $2::date AND ${loc}
      GROUP BY wo.id,wo.employee_id,wo.location_id,wo.discount_amount,wo.tip_amount)
      SELECT COALESCE(SUM(service_revenue),0)::numeric service_revenue,COALESCE(SUM(product_revenue),0)::numeric product_revenue,
      COALESCE(SUM(service_revenue+product_revenue),0)::numeric gross_revenue,COALESCE(SUM(discount_amount),0)::numeric discounts,
      COALESCE(SUM(tip_amount),0)::numeric tips,COUNT(*)::int closed_workorders,
      COALESCE(SUM(service_quantity),0)::numeric service_quantity,COALESCE(SUM(product_quantity),0)::numeric product_quantity
      FROM closed`, params, emptyRevenue, "pénzügy", warnings) : Promise.resolve({rows:[emptyRevenue]} as any),
    loadStock(financialVisible,locationId,warnings),
    safeQuery(`SELECT COUNT(*)::int visits,COUNT(DISTINCT vh.profile_id)::int unique_guests,
      ${financialVisible?"COALESCE(SUM(vh.amount_paid),0)::numeric":"0::numeric"} guest_revenue,
      ${financialVisible?"COALESCE(AVG(vh.amount_paid),0)::numeric":"0::numeric"} avg_guest_spend
      FROM crm_visit_history vh WHERE vh.visited_at::date BETWEEN $1::date AND $2::date AND ($3::text IS NULL OR vh.location_id::text=$3::text)`,params,emptyCrm,"CRM",warnings),
    safeQuery(`SELECT
      COUNT(*) FILTER (WHERE gp.first_visit_at::date BETWEEN $1::date AND $2::date)::int new_guests,
      COUNT(*) FILTER (WHERE gp.first_visit_at::date < $1::date AND gp.last_visit_at::date BETWEEN $1::date AND $2::date)::int returning_guests,
      COUNT(*) FILTER (WHERE gp.last_visit_at < ($2::date - INTERVAL '60 days'))::int inactive_guests
      FROM crm_guest_profiles gp
      WHERE ($3::text IS NULL OR gp.last_location_id::text=$3::text)`,params,emptyGuestSegments,"CRM vendégszegmensek",warnings),
    safeQuery(`SELECT wo.employee_id::text employee_id,COALESCE(e.full_name,'Nincs munkatárs') employee_name,
      COUNT(DISTINCT wo.id)::int workorder_count,${financialVisible?"COALESCE(SUM(wi.line_total),0)::numeric":"0::numeric"} revenue,
      ${financialVisible?"COALESCE(SUM(wi.line_total)/NULLIF(COUNT(DISTINCT wo.id),0),0)::numeric":"0::numeric"} avg_ticket
      FROM work_orders wo LEFT JOIN employees e ON e.id=wo.employee_id LEFT JOIN work_order_items wi ON wi.work_order_id=wo.id
      WHERE wo.financial_closed_at::date BETWEEN $1::date AND $2::date AND ${loc}
      GROUP BY wo.employee_id,e.full_name ORDER BY ${financialVisible?"revenue":"workorder_count"} DESC LIMIT 20`,params,{},"munkatársi teljesítmény",warnings),
  ]);

  const r = revenueRes.rows[0] || emptyRevenue, gross=n(r.gross_revenue), service=n(r.service_revenue), product=n(r.product_revenue);
  const serviceQuantity=n(r.service_quantity),productQuantity=n(r.product_quantity),segments=guestSegmentsRes.rows[0]||emptyGuestSegments;
  return { period:{from,to}, location_id:locationId, financial_visible:financialVisible,
    revenue:{ service_revenue:service,product_revenue:product,gross_revenue:gross,discounts:n(r.discounts),tips:n(r.tips),closed_workorders:n(r.closed_workorders),service_quantity:serviceQuantity,product_quantity:productQuantity,avg_service_price:serviceQuantity?service/serviceQuantity:0,avg_product_price:productQuantity?product/productQuantity:0,service_share_percent:gross?Math.round(service/gross*1000)/10:0,product_share_percent:gross?Math.round(product/gross*1000)/10:0 },
    stock:{ inventory_value:n(stockRes.rows[0]?.inventory_value),low_stock_count:n(stockRes.rows[0]?.low_stock_count),out_of_stock_count:n(stockRes.rows[0]?.out_of_stock_count),stocked_products:n(stockRes.rows[0]?.stocked_products) },
    crm:{ visits:n(crmRes.rows[0]?.visits),unique_guests:n(crmRes.rows[0]?.unique_guests),guest_revenue:n(crmRes.rows[0]?.guest_revenue),avg_guest_spend:n(crmRes.rows[0]?.avg_guest_spend),new_guests:n(segments.new_guests),returning_guests:n(segments.returning_guests),inactive_guests:n(segments.inactive_guests),inactive_after_days:60 },
    staff:(staffRes.rows||[]).filter((x:any)=>x.employee_name).map((x:any)=>({employee_id:x.employee_id,employee_name:x.employee_name,workorder_count:n(x.workorder_count),revenue:n(x.revenue),avg_ticket:n(x.avg_ticket)})),
    source_status:{ ok:warnings.length===0, warnings }
  };
}

const avg=(rows:any[],key:string)=>rows.length?rows.reduce((s,r)=>s+n(r[key]),0)/rows.length:0;
function percentile(rows:any[],key:string,p:number){const a=rows.map(r=>n(r[key])).filter(Number.isFinite).sort((x,y)=>x-y);if(!a.length)return 0;const pos=(a.length-1)*p,lo=Math.floor(pos),hi=Math.ceil(pos);return lo===hi?a[lo]:a[lo]+(a[hi]-a[lo])*(pos-lo)}

async function buildDecisionSupport(from:string,to:string,locationId:string|null,financialVisible:boolean,isAdmin:boolean){
  const warnings:string[]=[];
  const params=[from,to,locationId];
  const [heatmapRows,rebookingRows,staffRows,benchmarkRows]=await Promise.all([
    safeRows(`SELECT EXTRACT(ISODOW FROM a.start_time)::int weekday,EXTRACT(HOUR FROM a.start_time)::int hour,
      COUNT(*)::int appointments,COUNT(*) FILTER(WHERE a.status IN ('completed','paid'))::int completed,
      COUNT(*) FILTER(WHERE a.status='no_show')::int no_show
      FROM appointments a WHERE a.start_time::date BETWEEN $1::date AND $2::date
      AND ($3::text IS NULL OR a.location_id::text=$3::text) AND COALESCE(a.status,'') NOT IN ('cancelled','canceled')
      GROUP BY 1,2 ORDER BY 1,2`,params,"foglalási heatmap",warnings),
    safeRows(`WITH base AS (
      SELECT DISTINCT a.id,a.client_id,a.end_time,a.location_id FROM appointments a
      JOIN work_orders wo ON wo.appointment_id=a.id
      WHERE wo.financial_closed_at::date BETWEEN $1::date AND $2::date AND a.client_id IS NOT NULL
      AND ($3::text IS NULL OR a.location_id::text=$3::text)), scored AS (
      SELECT b.*,EXISTS(SELECT 1 FROM appointments nx WHERE nx.client_id=b.client_id AND nx.start_time>b.end_time
        AND nx.start_time<=b.end_time+INTERVAL '90 days' AND COALESCE(nx.status,'') NOT IN ('cancelled','canceled','no_show')) rebooked,
        EXISTS(SELECT 1 FROM appointments nx WHERE nx.client_id=b.client_id AND nx.start_time>b.end_time
        AND nx.start_time<=b.end_time+INTERVAL '90 days' AND nx.created_at<=b.end_time+INTERVAL '24 hours'
        AND COALESCE(nx.status,'') NOT IN ('cancelled','canceled','no_show')) immediate_rebooked FROM base b)
      SELECT COUNT(*)::int eligible_visits,COUNT(*) FILTER(WHERE rebooked)::int rebooked_visits,
        COUNT(*) FILTER(WHERE immediate_rebooked)::int immediate_rebooked_visits,
        COALESCE(100.0*COUNT(*) FILTER(WHERE rebooked)/NULLIF(COUNT(*),0),0)::numeric rebooking_rate_percent,
        COALESCE(100.0*COUNT(*) FILTER(WHERE immediate_rebooked)/NULLIF(COUNT(*),0),0)::numeric immediate_rebooking_rate_percent FROM scored`,params,"rebooking",warnings),
    safeRows(`WITH rev AS (
      SELECT wo.employee_id,${financialVisible?"COALESCE(SUM(wi.line_total),0)::numeric":"0::numeric"} revenue,COUNT(DISTINCT wo.id)::int workorders
      FROM work_orders wo LEFT JOIN work_order_items wi ON wi.work_order_id=wo.id
      WHERE wo.employee_id IS NOT NULL AND wo.financial_closed_at::date BETWEEN $1::date AND $2::date
      AND ($3::text IS NULL OR wo.location_id::text=$3::text) GROUP BY wo.employee_id), ts AS (
      SELECT t.employee_id,COALESCE(SUM(CASE WHEN COALESCE(t.regular_minutes,0)+COALESCE(t.overtime_minutes,0)>0
        THEN COALESCE(t.regular_minutes,0)+COALESCE(t.overtime_minutes,0)
        WHEN t.clock_in IS NOT NULL AND t.clock_out IS NOT NULL THEN GREATEST(EXTRACT(EPOCH FROM(t.clock_out-t.clock_in))/60-COALESCE(t.break_minutes,0),0) ELSE 0 END),0)::numeric paid_minutes
      FROM timesheets t WHERE t.work_date BETWEEN $1::date AND $2::date AND COALESCE(t.status,'') NOT IN ('cancelled','rejected')
      AND ($3::text IS NULL OR t.location_id::text=$3::text) GROUP BY t.employee_id), svc AS (
      SELECT a.employee_id,COALESCE(SUM(GREATEST(EXTRACT(EPOCH FROM(a.end_time-a.start_time))/60,0)),0)::numeric service_minutes,COUNT(*)::int appointments
      FROM appointments a WHERE a.employee_id IS NOT NULL AND a.start_time::date BETWEEN $1::date AND $2::date
      AND ($3::text IS NULL OR a.location_id::text=$3::text) AND a.end_time<=now()
      AND COALESCE(a.status,'') NOT IN ('cancelled','canceled','no_show') GROUP BY a.employee_id), ids AS (
      SELECT employee_id FROM rev UNION SELECT employee_id FROM ts UNION SELECT employee_id FROM svc)
      SELECT ids.employee_id::text,COALESCE(e.full_name,e.email,'Nincs név') employee_name,COALESCE(rev.revenue,0)::numeric revenue,
        COALESCE(rev.workorders,0)::int workorders,COALESCE(ts.paid_minutes,0)::numeric paid_minutes,COALESCE(svc.service_minutes,0)::numeric service_minutes,
        COALESCE(svc.appointments,0)::int appointments,
        CASE WHEN COALESCE(ts.paid_minutes,0)>0 THEN COALESCE(rev.revenue,0)/(ts.paid_minutes/60.0)
             WHEN COALESCE(svc.service_minutes,0)>0 THEN COALESCE(rev.revenue,0)/(svc.service_minutes/60.0) ELSE 0 END::numeric revenue_per_hour,
        CASE WHEN COALESCE(ts.paid_minutes,0)>0 THEN 100.0*COALESCE(svc.service_minutes,0)/ts.paid_minutes ELSE NULL END::numeric utilization_percent,
        CASE WHEN COALESCE(ts.paid_minutes,0)>0 THEN 'timesheet' WHEN COALESCE(svc.service_minutes,0)>0 THEN 'appointment_duration' ELSE 'none' END hour_source
      FROM ids LEFT JOIN employees e ON e.id=ids.employee_id LEFT JOIN rev ON rev.employee_id=ids.employee_id
      LEFT JOIN ts ON ts.employee_id=ids.employee_id LEFT JOIN svc ON svc.employee_id=ids.employee_id
      ORDER BY revenue_per_hour DESC,revenue DESC LIMIT 50`,params,"munkatársi Revenue/Hour",warnings),
    safeRows(`WITH ap AS (
      SELECT a.location_id,COUNT(*) FILTER(WHERE COALESCE(a.status,'') NOT IN ('cancelled','canceled'))::int appointments,
        COUNT(*) FILTER(WHERE a.status IN ('completed','paid'))::int completed,
        COUNT(*) FILTER(WHERE a.status='no_show')::int no_show
      FROM appointments a WHERE a.start_time::date BETWEEN $1::date AND $2::date AND a.location_id IS NOT NULL GROUP BY a.location_id), rev AS (
      SELECT wo.location_id,${financialVisible?"COALESCE(SUM(wi.line_total),0)::numeric":"0::numeric"} revenue,COUNT(DISTINCT wo.id)::int workorders
      FROM work_orders wo LEFT JOIN work_order_items wi ON wi.work_order_id=wo.id
      WHERE wo.financial_closed_at::date BETWEEN $1::date AND $2::date AND wo.location_id IS NOT NULL GROUP BY wo.location_id), base AS (
      SELECT DISTINCT a.id,a.client_id,a.end_time,a.location_id FROM appointments a JOIN work_orders wo ON wo.appointment_id=a.id
      WHERE wo.financial_closed_at::date BETWEEN $1::date AND $2::date AND a.client_id IS NOT NULL AND a.location_id IS NOT NULL), rb AS (
      SELECT b.location_id,COUNT(*)::int eligible,COUNT(*) FILTER(WHERE EXISTS(SELECT 1 FROM appointments nx WHERE nx.client_id=b.client_id
        AND nx.start_time>b.end_time AND nx.start_time<=b.end_time+INTERVAL '90 days' AND COALESCE(nx.status,'') NOT IN ('cancelled','canceled','no_show')))::int rebooked
      FROM base b GROUP BY b.location_id)
      SELECT l.id::text location_id,l.name,COALESCE(ap.appointments,0)::int appointments,COALESCE(ap.completed,0)::int completed,
        COALESCE(ap.no_show,0)::int no_show,COALESCE(rev.revenue,0)::numeric revenue,COALESCE(rev.workorders,0)::int workorders,
        COALESCE(100.0*ap.completed/NULLIF(ap.appointments,0),0)::numeric completion_rate_percent,
        COALESCE(100.0*ap.no_show/NULLIF(ap.appointments,0),0)::numeric no_show_rate_percent,
        COALESCE(100.0*rb.rebooked/NULLIF(rb.eligible,0),0)::numeric rebooking_rate_percent,
        COALESCE(rev.revenue/NULLIF(rev.workorders,0),0)::numeric avg_ticket
      FROM locations l LEFT JOIN ap ON ap.location_id=l.id LEFT JOIN rev ON rev.location_id=l.id LEFT JOIN rb ON rb.location_id=l.id
      WHERE COALESCE(l.active,true)=true ORDER BY revenue DESC,appointments DESC`,[from,to],"hálózati benchmark",warnings)
  ]);

  const r=rebookingRows[0]||{};
  const normalizedStaff=staffRows.map(x=>({employee_id:String(x.employee_id||''),employee_name:String(x.employee_name||'Nincs név'),revenue:n(x.revenue),workorders:n(x.workorders),paid_hours:n(x.paid_minutes)/60,service_hours:n(x.service_minutes)/60,appointments:n(x.appointments),revenue_per_hour:n(x.revenue_per_hour),utilization_percent:x.utilization_percent==null?null:n(x.utilization_percent),hour_source:String(x.hour_source||'none')}));
  const normalizedBench=benchmarkRows.map(x=>({location_id:String(x.location_id||''),name:String(x.name||''),appointments:n(x.appointments),completed:n(x.completed),no_show:n(x.no_show),revenue:n(x.revenue),workorders:n(x.workorders),completion_rate_percent:n(x.completion_rate_percent),no_show_rate_percent:n(x.no_show_rate_percent),rebooking_rate_percent:n(x.rebooking_rate_percent),avg_ticket:n(x.avg_ticket)}));
  const metricKeys=["revenue","appointments","completion_rate_percent","no_show_rate_percent","rebooking_rate_percent","avg_ticket"];
  const network:any={};
  for(const key of metricKeys) network[key]={average:avg(normalizedBench,key),top_quartile:percentile(normalizedBench,key,key==="no_show_rate_percent"?.25:.75)};
  const current=locationId?normalizedBench.find(x=>x.location_id===locationId)||null:null;
  return {period:{from,to},location_id:locationId,financial_visible:financialVisible,
    heatmap:heatmapRows.map(x=>({weekday:n(x.weekday),hour:n(x.hour),appointments:n(x.appointments),completed:n(x.completed),no_show:n(x.no_show)})),
    rebooking:{eligible_visits:n(r.eligible_visits),rebooked_visits:n(r.rebooked_visits),immediate_rebooked_visits:n(r.immediate_rebooked_visits),rebooking_rate_percent:n(r.rebooking_rate_percent),immediate_rebooking_rate_percent:n(r.immediate_rebooking_rate_percent),horizon_days:90,immediate_window_hours:24},
    staff_revenue_hour:normalizedStaff,
    benchmark:{current,network,locations:isAdmin?normalizedBench:undefined,location_count:normalizedBench.length},
    source_status:{ok:warnings.length===0,warnings}
  };
}

router.get("/decision-support",async(req:AuthRequest,res,next)=>{
  try{
    const financialVisible=await canViewFinancial(req);
    const from=String(req.query.from||new Date(Date.now()-29*86400000).toISOString().slice(0,10));
    const to=String(req.query.to||new Date().toISOString().slice(0,10));
    const requestedLocation=String(req.query.location_id||"").trim()||null;
    const roles=roleKeys(req),isAdmin=roles.includes("admin");
    const locationId=isAdmin?requestedLocation:(req.user?.location_id?String(req.user.location_id):null);
    const cacheKey=`management-bi:${scopedCacheKey([from,to,locationId,financialVisible,isAdmin])}`;
    const payload=await shortCache(cacheKey,MANAGEMENT_CACHE_MS,()=>timed(`/management/decision-support ${from}..${to} ${locationId||"all"}`,()=>buildDecisionSupport(from,to,locationId,financialVisible,isAdmin)));
    res.setHeader("Cache-Control","private, no-store");res.json(payload);
  }catch(err){next(err)}
});

router.get(["/", "/summary"], async (req: AuthRequest, res, next) => {
  try {
    const financialVisible=await canViewFinancial(req);
    const from = String(req.query.from || new Date(Date.now()-29*86400000).toISOString().slice(0,10));
    const to = String(req.query.to || new Date().toISOString().slice(0,10));
    const requestedLocation = String(req.query.location_id || "").trim() || null;
    const roles = roleKeys(req);
    const isAdmin = roles.includes("admin");
    const locationId = isAdmin ? requestedLocation : (req.user?.location_id ? String(req.user.location_id) : null);
    const cacheKey=`management-summary:${scopedCacheKey([from,to,locationId,financialVisible,roles.sort().join(",")])}`;
    const payload=await shortCache(cacheKey,MANAGEMENT_CACHE_MS,()=>timed(`/management/summary ${from}..${to} ${locationId||"all"}`,()=>buildSummary(from,to,locationId,financialVisible)));
    res.setHeader("Cache-Control","private, no-store");
    res.json(payload);
  } catch(err){ next(err); }
});
export default router;
