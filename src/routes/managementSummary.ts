import { Router } from "express";
import db from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

const n = (value: unknown) => Number(value || 0);

router.get("/summary", async (req: AuthRequest, res, next) => {
  try {
    const from = String(req.query.from || new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10));
    const to = String(req.query.to || new Date().toISOString().slice(0, 10));
    const requestedLocation = String(req.query.location_id || "").trim() || null;
    const rawRole: any = req.user?.role;
    const roles = Array.isArray(rawRole)
      ? rawRole.map(String)
      : String(rawRole || "").replace(/[\[\]"]/g, "").split(",").map(x => x.trim()).filter(Boolean);
    const isAdmin = roles.map(x => x.toLowerCase()).includes("admin");
    const locationId = isAdmin ? requestedLocation : (req.user?.location_id ? String(req.user.location_id) : null);

    const params: any[] = [from, to, locationId];
    const locationFilter = `($3::text IS NULL OR wo.location_id::text = $3::text)`;

    const [revenueRes, stockRes, crmRes, staffRes] = await Promise.all([
      db.query(
        `WITH closed AS (
           SELECT wo.id, wo.employee_id, wo.location_id, wo.discount_amount, wo.tip_amount,
                  COALESCE(SUM(CASE WHEN wi.item_type='service' THEN wi.line_total ELSE 0 END),0)::numeric service_revenue,
                  COALESCE(SUM(CASE WHEN wi.item_type='product' THEN wi.line_total ELSE 0 END),0)::numeric product_revenue
           FROM work_orders wo
           LEFT JOIN work_order_items wi ON wi.work_order_id = wo.id
           WHERE wo.financial_closed_at::date BETWEEN $1::date AND $2::date
             AND ${locationFilter}
           GROUP BY wo.id, wo.employee_id, wo.location_id, wo.discount_amount, wo.tip_amount
         )
         SELECT
           COALESCE(SUM(service_revenue),0)::numeric AS service_revenue,
           COALESCE(SUM(product_revenue),0)::numeric AS product_revenue,
           COALESCE(SUM(service_revenue + product_revenue),0)::numeric AS gross_revenue,
           COALESCE(SUM(discount_amount),0)::numeric AS discounts,
           COALESCE(SUM(tip_amount),0)::numeric AS tips,
           COUNT(*)::int AS closed_workorders
         FROM closed`,
        params
      ),
      db.query(
        `SELECT
           COALESCE(SUM(b.quantity * COALESCE(b.unit_cost,0)),0)::numeric AS inventory_value,
           COUNT(*) FILTER (WHERE b.quantity > 0 AND b.quantity <= COALESCE(b.min_quantity,0))::int AS low_stock_count,
           COUNT(*) FILTER (WHERE b.quantity <= 0)::int AS out_of_stock_count,
           COUNT(*) FILTER (WHERE b.quantity > 0)::int AS stocked_products
         FROM product_stock_balances b
         WHERE ($1::text IS NULL OR b.location_id::text = $1::text)`,
        [locationId]
      ),
      db.query(
        `SELECT
           COUNT(*)::int AS visits,
           COUNT(DISTINCT vh.profile_id)::int AS unique_guests,
           COALESCE(SUM(vh.amount_paid),0)::numeric AS guest_revenue,
           COALESCE(AVG(vh.amount_paid),0)::numeric AS avg_guest_spend
         FROM crm_visit_history vh
         WHERE vh.visited_at::date BETWEEN $1::date AND $2::date
           AND ($3::text IS NULL OR vh.location_id::text = $3::text)`,
        params
      ),
      db.query(
        `SELECT
           wo.employee_id::text AS employee_id,
           COALESCE(e.full_name,'Nincs munkatárs') AS employee_name,
           COUNT(DISTINCT wo.id)::int AS workorder_count,
           COALESCE(SUM(wi.line_total),0)::numeric AS revenue,
           COALESCE(SUM(wi.line_total) / NULLIF(COUNT(DISTINCT wo.id),0),0)::numeric AS avg_ticket
         FROM work_orders wo
         LEFT JOIN employees e ON e.id = wo.employee_id
         LEFT JOIN work_order_items wi ON wi.work_order_id = wo.id
         WHERE wo.financial_closed_at::date BETWEEN $1::date AND $2::date
           AND ${locationFilter}
         GROUP BY wo.employee_id, e.full_name
         ORDER BY revenue DESC
         LIMIT 20`,
        params
      ),
    ]);

    const revenue = revenueRes.rows[0] || {};
    const gross = n(revenue.gross_revenue);
    const service = n(revenue.service_revenue);
    const product = n(revenue.product_revenue);

    res.json({
      period: { from, to },
      location_id: locationId,
      revenue: {
        service_revenue: service,
        product_revenue: product,
        gross_revenue: gross,
        discounts: n(revenue.discounts),
        tips: n(revenue.tips),
        closed_workorders: n(revenue.closed_workorders),
        service_share_percent: gross > 0 ? Math.round(service / gross * 1000) / 10 : 0,
        product_share_percent: gross > 0 ? Math.round(product / gross * 1000) / 10 : 0,
      },
      stock: {
        inventory_value: n(stockRes.rows[0]?.inventory_value),
        low_stock_count: n(stockRes.rows[0]?.low_stock_count),
        out_of_stock_count: n(stockRes.rows[0]?.out_of_stock_count),
        stocked_products: n(stockRes.rows[0]?.stocked_products),
      },
      crm: {
        visits: n(crmRes.rows[0]?.visits),
        unique_guests: n(crmRes.rows[0]?.unique_guests),
        guest_revenue: n(crmRes.rows[0]?.guest_revenue),
        avg_guest_spend: n(crmRes.rows[0]?.avg_guest_spend),
      },
      staff: staffRes.rows.map((row: any) => ({
        employee_id: row.employee_id,
        employee_name: row.employee_name,
        workorder_count: n(row.workorder_count),
        revenue: n(row.revenue),
        avg_ticket: n(row.avg_ticket),
      })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
