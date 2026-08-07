import { Router } from "express";
import db from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { requireFeature } from "../middleware/featureAccess";

const router = Router();
router.use(requireAuth);
router.use(requireFeature("management_dashboard"));
const n = (v: unknown) => Number(v || 0);
const emptyRevenue = { service_revenue:0, product_revenue:0, gross_revenue:0, discounts:0, tips:0, closed_workorders:0 };
const emptyStock = { inventory_value:0, low_stock_count:0, out_of_stock_count:0, stocked_products:0 };
const emptyCrm = { visits:0, unique_guests:0, guest_revenue:0, avg_guest_spend:0 };

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

router.get(["/", "/summary"], async (req: AuthRequest, res, next) => {
  try {
    const financialVisible=await canViewFinancial(req);
    const from = String(req.query.from || new Date(Date.now()-29*86400000).toISOString().slice(0,10));
    const to = String(req.query.to || new Date().toISOString().slice(0,10));
    const requestedLocation = String(req.query.location_id || "").trim() || null;
    const roles = roleKeys(req);
    const isAdmin = roles.includes("admin");
    const locationId = isAdmin ? requestedLocation : (req.user?.location_id ? String(req.user.location_id) : null);
    const params:any[] = [from,to,locationId];
    const loc = `($3::text IS NULL OR wo.location_id::text=$3::text)`;
    const warnings:string[] = [];

    const revenueRes = financialVisible ? await safeQuery(`WITH closed AS (
      SELECT wo.id,wo.employee_id,wo.location_id,COALESCE(wo.discount_amount,0) discount_amount,COALESCE(wo.tip_amount,0) tip_amount,
        COALESCE(SUM(CASE WHEN wi.item_type='service' THEN wi.line_total ELSE 0 END),0)::numeric service_revenue,
        COALESCE(SUM(CASE WHEN wi.item_type='product' THEN wi.line_total ELSE 0 END),0)::numeric product_revenue
      FROM work_orders wo LEFT JOIN work_order_items wi ON wi.work_order_id=wo.id
      WHERE wo.financial_closed_at::date BETWEEN $1::date AND $2::date AND ${loc}
      GROUP BY wo.id,wo.employee_id,wo.location_id,wo.discount_amount,wo.tip_amount)
      SELECT COALESCE(SUM(service_revenue),0)::numeric service_revenue,COALESCE(SUM(product_revenue),0)::numeric product_revenue,
      COALESCE(SUM(service_revenue+product_revenue),0)::numeric gross_revenue,COALESCE(SUM(discount_amount),0)::numeric discounts,
      COALESCE(SUM(tip_amount),0)::numeric tips,COUNT(*)::int closed_workorders FROM closed`, params, emptyRevenue, "pénzügy", warnings) : {rows:[emptyRevenue]};

    let stockRes:any;
    try {
      stockRes = await db.query(`SELECT ${financialVisible?"COALESCE(SUM(b.quantity*COALESCE(b.unit_cost,0)),0)::numeric":"0::numeric"} inventory_value,
        COUNT(*) FILTER(WHERE b.quantity>0 AND b.quantity<=COALESCE(b.min_quantity,0))::int low_stock_count,
        COUNT(*) FILTER(WHERE b.quantity<=0)::int out_of_stock_count,COUNT(*) FILTER(WHERE b.quantity>0)::int stocked_products
        FROM product_stock_balances b WHERE ($1::text IS NULL OR b.location_id::text=$1::text)`,[locationId]);
    } catch(err:any) {
      if (String(err?.code)==="42703") {
        warnings.push(`készlet: unit_cost/min_quantity még nincs migrálva`);
        stockRes = await safeQuery(`SELECT 0::numeric inventory_value,0::int low_stock_count,
          COUNT(*) FILTER(WHERE b.quantity<=0)::int out_of_stock_count,COUNT(*) FILTER(WHERE b.quantity>0)::int stocked_products
          FROM product_stock_balances b WHERE ($1::text IS NULL OR b.location_id::text=$1::text)`,[locationId],emptyStock,"készlet",warnings);
      } else if (String(err?.code)==="42P01") { warnings.push(`készlet: tábla még nincs migrálva`); stockRes={rows:[emptyStock]}; }
      else throw err;
    }

    const crmRes = await safeQuery(`SELECT COUNT(*)::int visits,COUNT(DISTINCT vh.profile_id)::int unique_guests,
      ${financialVisible?"COALESCE(SUM(vh.amount_paid),0)::numeric":"0::numeric"} guest_revenue,
      ${financialVisible?"COALESCE(AVG(vh.amount_paid),0)::numeric":"0::numeric"} avg_guest_spend
      FROM crm_visit_history vh WHERE vh.visited_at::date BETWEEN $1::date AND $2::date AND ($3::text IS NULL OR vh.location_id::text=$3::text)`,params,emptyCrm,"CRM",warnings);

    const staffRes = await safeQuery(`SELECT wo.employee_id::text employee_id,COALESCE(e.full_name,'Nincs munkatárs') employee_name,
      COUNT(DISTINCT wo.id)::int workorder_count,${financialVisible?"COALESCE(SUM(wi.line_total),0)::numeric":"0::numeric"} revenue,
      ${financialVisible?"COALESCE(SUM(wi.line_total)/NULLIF(COUNT(DISTINCT wo.id),0),0)::numeric":"0::numeric"} avg_ticket
      FROM work_orders wo LEFT JOIN employees e ON e.id=wo.employee_id LEFT JOIN work_order_items wi ON wi.work_order_id=wo.id
      WHERE wo.financial_closed_at::date BETWEEN $1::date AND $2::date AND ${loc}
      GROUP BY wo.employee_id,e.full_name ORDER BY ${financialVisible?"revenue":"workorder_count"} DESC LIMIT 20`,params,{},"munkatársi teljesítmény",warnings);

    const r = revenueRes.rows[0] || emptyRevenue, gross=n(r.gross_revenue), service=n(r.service_revenue), product=n(r.product_revenue);
    res.json({ period:{from,to}, location_id:locationId, financial_visible:financialVisible,
      revenue:{ service_revenue:service,product_revenue:product,gross_revenue:gross,discounts:n(r.discounts),tips:n(r.tips),closed_workorders:n(r.closed_workorders),service_share_percent:gross?Math.round(service/gross*1000)/10:0,product_share_percent:gross?Math.round(product/gross*1000)/10:0 },
      stock:{ inventory_value:n(stockRes.rows[0]?.inventory_value),low_stock_count:n(stockRes.rows[0]?.low_stock_count),out_of_stock_count:n(stockRes.rows[0]?.out_of_stock_count),stocked_products:n(stockRes.rows[0]?.stocked_products) },
      crm:{ visits:n(crmRes.rows[0]?.visits),unique_guests:n(crmRes.rows[0]?.unique_guests),guest_revenue:n(crmRes.rows[0]?.guest_revenue),avg_guest_spend:n(crmRes.rows[0]?.avg_guest_spend) },
      staff:(staffRes.rows||[]).filter((x:any)=>x.employee_name).map((x:any)=>({employee_id:x.employee_id,employee_name:x.employee_name,workorder_count:n(x.workorder_count),revenue:n(x.revenue),avg_ticket:n(x.avg_ticket)})),
      source_status:{ ok:warnings.length===0, warnings }
    });
  } catch(err){ next(err); }
});
export default router;
