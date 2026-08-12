import { Router } from "express";
import db from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { loyaltyDiscountForWorkOrder } from "../loyalty/loyaltyProgramService";
import { requireFeature } from "../middleware/featureAccess";

const router = Router();
router.use(requireAuth);
router.use(requireFeature("finance"));

const PAYMENT_METHODS = new Set(["cash", "card", "transfer", "voucher", "other"]);

function money(value: unknown) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function crmKey(order: any) {
  const email = String(order?.client_email || "").trim().toLowerCase();
  if (email) return `email:${email}`;
  const phone = String(order?.client_phone || "").replace(/[^0-9+]/g, "");
  if (phone) return `phone:${phone}`;
  const name = String(order?.client_name || "Vendég").trim().toLocaleLowerCase("hu-HU").replace(/\s+/g, " ");
  return `name:${name || "ismeretlen"}`;
}

async function syncClosedWorkOrderToCrm(client: any, workOrderId: string, order: any) {
  const items = await client.query(`SELECT item_type, item_name FROM work_order_items WHERE work_order_id=$1 ORDER BY created_at`, [workOrderId]);
  const services = items.rows.filter((r: any) => r.item_type === "service").map((r: any) => String(r.item_name || "")).filter(Boolean);
  const products = items.rows.filter((r: any) => r.item_type === "product").map((r: any) => String(r.item_name || "")).filter(Boolean);
  const visitedAt = order.completed_at || order.financial_closed_at || new Date().toISOString();
  const key = crmKey(order);

  const profile = await client.query(
    `INSERT INTO crm_guest_profiles
      (contact_key,client_name,client_email,client_phone,first_visit_at,last_visit_at,last_location_id,last_employee_id,last_service_names,last_product_names)
     VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8::jsonb,$9::jsonb)
     ON CONFLICT (contact_key) DO UPDATE SET
       client_name=COALESCE(EXCLUDED.client_name,crm_guest_profiles.client_name),
       client_email=COALESCE(EXCLUDED.client_email,crm_guest_profiles.client_email),
       client_phone=COALESCE(EXCLUDED.client_phone,crm_guest_profiles.client_phone),
       updated_at=now()
     RETURNING id`,
    [key, order.client_name || null, order.client_email || null, order.client_phone || null, visitedAt,
     order.location_id == null ? null : String(order.location_id), order.employee_id == null ? null : String(order.employee_id),
     JSON.stringify(services), JSON.stringify(products)]
  );

  const inserted = await client.query(
    `INSERT INTO crm_visit_history
      (profile_id,work_order_id,visited_at,location_id,employee_id,gross_total,discount_amount,tip_amount,amount_paid,service_names,product_names)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb)
     ON CONFLICT (work_order_id) DO NOTHING
     RETURNING id`,
    [profile.rows[0].id, String(workOrderId), visitedAt,
     order.location_id == null ? null : String(order.location_id), order.employee_id == null ? null : String(order.employee_id),
     money(order.gross_total), money(order.discount_amount), money(order.tip_amount), money(order.amount_paid),
     JSON.stringify(services), JSON.stringify(products)]
  );

  if (inserted.rows[0]) {
    await client.query(
      `UPDATE crm_guest_profiles
       SET first_visit_at=COALESCE(first_visit_at,$2),
           last_visit_at=GREATEST(COALESCE(last_visit_at,$2),$2),
           visit_count=visit_count+1,
           total_spent=total_spent+$3,
           total_discount=total_discount+$4,
           total_tip=total_tip+$5,
           last_service_names=$6::jsonb,
           last_product_names=$7::jsonb,
           last_location_id=$8,
           last_employee_id=$9,
           updated_at=now()
       WHERE id=$1`,
      [profile.rows[0].id, visitedAt, money(order.amount_paid), money(order.discount_amount), money(order.tip_amount),
       JSON.stringify(services), JSON.stringify(products),
       order.location_id == null ? null : String(order.location_id), order.employee_id == null ? null : String(order.employee_id)]
    );
  }
}

async function orderFinancials(client: any, workOrderId: string) {
  const items = await client.query(`SELECT COALESCE(SUM(line_total),0)::numeric AS gross_total FROM work_order_items WHERE work_order_id = $1`, [workOrderId]);
  const payments = await client.query(`SELECT COALESCE(SUM(amount),0)::numeric AS amount_paid FROM work_order_payments WHERE work_order_id = $1`, [workOrderId]);
  return { grossTotal: money(items.rows[0]?.gross_total), paid: money(payments.rows[0]?.amount_paid) };
}

router.get("/workorders", async (req: AuthRequest, res, next) => {
  try {
    const locationId = String(req.query.location_id || "").trim();
    const params: any[] = [];
    let where = "WHERE wo.status NOT IN ('cancelled','no_show')";
    if (locationId) { params.push(locationId); where += ` AND wo.location_id::text = $${params.length}`; }
    const { rows } = await db.query(
      `SELECT wo.id, wo.created_at, wo.completed_at, wo.status, wo.client_name, wo.employee_id,
              wo.location_id, wo.payment_status, wo.invoice_status, wo.discount_amount,
              wo.tip_amount, wo.amount_due, wo.amount_paid, wo.financial_closed_at,
              COALESCE(i.gross_total,0)::numeric AS gross_total,
              COALESCE(p.paid_total,0)::numeric AS paid_total
       FROM work_orders wo
       LEFT JOIN LATERAL (SELECT SUM(line_total)::numeric AS gross_total FROM work_order_items wi WHERE wi.work_order_id = wo.id) i ON true
       LEFT JOIN LATERAL (SELECT SUM(amount)::numeric AS paid_total FROM work_order_payments wp WHERE wp.work_order_id = wo.id) p ON true
       ${where}
       ORDER BY COALESCE(wo.completed_at, wo.created_at) DESC LIMIT 200`, params);
    res.json(rows);
  } catch (err) { next(err); }
});

router.get("/workorders/:id", async (req: AuthRequest, res, next) => {
  try {
    const header = await db.query(`SELECT * FROM work_orders WHERE id = $1`, [req.params.id]);
    if (!header.rows[0]) return res.status(404).json({ message: "A munkalap nem található." });
    const items = await db.query(`SELECT id,item_type,item_name,quantity,unit_price,discount_amount,line_total FROM work_order_items WHERE work_order_id=$1 ORDER BY created_at`, [req.params.id]);
    const payments = await db.query(`SELECT id,payment_method,amount,paid_at,note FROM work_order_payments WHERE work_order_id=$1 ORDER BY paid_at`, [req.params.id]);
    const calc = await orderFinancials(db, req.params.id);
    res.json({ ...header.rows[0], items: items.rows, payments: payments.rows, calculated_gross_total: calc.grossTotal, calculated_paid_total: calc.paid });
  } catch (err) { next(err); }
});

router.post("/workorders/:id/settle", async (req: AuthRequest, res, next) => {
  const client = await db.connect();
  try {
    const requestedDiscount = Math.max(0, money(req.body?.discount_amount));
    const tip = Math.max(0, money(req.body?.tip_amount));
    const invoiceStatus = String(req.body?.invoice_status || "not_requested");
    const closeFinancially = Boolean(req.body?.close_financially);
    const incomingPayments = Array.isArray(req.body?.payments) ? req.body.payments : [];
    await client.query("BEGIN");
    const locked = await client.query(`SELECT * FROM work_orders WHERE id=$1 FOR UPDATE`, [req.params.id]);
    if (!locked.rows[0]) { await client.query("ROLLBACK"); return res.status(404).json({ message: "A munkalap nem található." }); }

    for (const p of incomingPayments) {
      const method = String(p?.payment_method || "").toLowerCase();
      const amount = money(p?.amount);
      if (!PAYMENT_METHODS.has(method)) throw new Error(`Érvénytelen fizetési mód: ${method}`);
      if (!(amount > 0)) throw new Error("A fizetési összegnek pozitívnak kell lennie.");
      await client.query(`INSERT INTO work_order_payments (work_order_id,payment_method,amount,paid_at,note) VALUES ($1,$2,$3,now(),$4)`, [req.params.id, method, amount, p?.note || null]);
    }

    const calc = await orderFinancials(client, req.params.id);
    const loyalty = await loyaltyDiscountForWorkOrder(client,req.params.id,calc.grossTotal);
    const discount = Math.max(requestedDiscount,money(loyalty.amount));
    const amountDue = Math.max(0, money(calc.grossTotal - discount + tip));
    const amountPaid = calc.paid;
    const paymentStatus = amountPaid <= 0 ? "unpaid" : amountPaid + 0.009 < amountDue ? "partial" : "paid";
    if (closeFinancially && paymentStatus !== "paid") throw new Error(`A munkalap nem zárható pénzügyileg: még ${money(amountDue - amountPaid)} Ft fizetendő.`);

    const updated = await client.query(
      `UPDATE work_orders
       SET gross_total=$2, discount_amount=$3, tip_amount=$4, amount_due=$5, amount_paid=$6,
           payment_status=$7, fully_paid=($7='paid'), invoice_status=$8,
           financial_closed_at=CASE WHEN $9 THEN COALESCE(financial_closed_at,now()) ELSE financial_closed_at END,
           financial_closed_by=CASE WHEN $9 THEN COALESCE(financial_closed_by,$10) ELSE financial_closed_by END,
           loyalty_tier_code=$11,loyalty_discount_percent=$12,loyalty_discount_amount=$13,updated_at=now()
       WHERE id=$1 RETURNING *`,
      [req.params.id, calc.grossTotal, discount, tip, amountDue, amountPaid, paymentStatus, invoiceStatus, closeFinancially, req.user?.email || String(req.user?.id || ""),loyalty.tier_code,loyalty.percent,loyalty.amount]
    );

    if (closeFinancially) await syncClosedWorkOrderToCrm(client, req.params.id, updated.rows[0]);
    await client.query("COMMIT");
    res.json(updated.rows[0]);
  } catch (err: any) {
    await client.query("ROLLBACK");
    const message = String(err?.message || "Pénzügyi lezárási hiba");
    if (message.startsWith("Érvénytelen") || message.startsWith("A fizetési") || message.startsWith("A munkalap nem zárható")) return res.status(400).json({ message });
    next(err);
  } finally { client.release(); }
});

router.get("/daily-summary", async (req: AuthRequest, res, next) => {
  try {
    const businessDate = String(req.query.date || new Date().toISOString().slice(0,10));
    const locationId = String(req.query.location_id || "").trim();
    const params: any[] = [businessDate]; let locationFilter = "";
    if (locationId) { params.push(locationId); locationFilter = `AND wo.location_id::text = $2`; }
    const { rows } = await db.query(
      `SELECT COALESCE(SUM(CASE WHEN wp.payment_method='cash' THEN wp.amount ELSE 0 END),0)::numeric AS cash_sales,
              COALESCE(SUM(CASE WHEN wp.payment_method='card' THEN wp.amount ELSE 0 END),0)::numeric AS card_sales,
              COALESCE(SUM(CASE WHEN wp.payment_method='transfer' THEN wp.amount ELSE 0 END),0)::numeric AS transfer_sales,
              COALESCE(SUM(CASE WHEN wp.payment_method='voucher' THEN wp.amount ELSE 0 END),0)::numeric AS voucher_sales,
              COALESCE(SUM(CASE WHEN wp.payment_method='other' THEN wp.amount ELSE 0 END),0)::numeric AS other_sales,
              COALESCE(SUM(DISTINCT wo.tip_amount),0)::numeric AS tips,
              COALESCE(SUM(DISTINCT wo.discount_amount),0)::numeric AS discounts,
              COUNT(DISTINCT wo.id)::int AS workorder_count
       FROM work_order_payments wp JOIN work_orders wo ON wo.id=wp.work_order_id
       WHERE wp.paid_at::date=$1::date ${locationFilter}`, params);
    res.json({ business_date: businessDate, location_id: locationId || null, ...rows[0] });
  } catch (err) { next(err); }
});

router.post("/daily-close", async (req: AuthRequest, res, next) => {
  try {
    const businessDate = String(req.body?.business_date || new Date().toISOString().slice(0,10));
    const locationId = req.body?.location_id == null ? null : String(req.body.location_id);
    const openingCash = money(req.body?.opening_cash); const countedCash = money(req.body?.counted_cash);
    const params: any[] = [businessDate]; let locationFilter = "";
    if (locationId) { params.push(locationId); locationFilter = `AND wo.location_id::text = $2`; }
    const totals = await db.query(
      `SELECT COALESCE(SUM(CASE WHEN wp.payment_method='cash' THEN wp.amount ELSE 0 END),0)::numeric AS cash_sales,
              COALESCE(SUM(CASE WHEN wp.payment_method='card' THEN wp.amount ELSE 0 END),0)::numeric AS card_sales,
              COALESCE(SUM(CASE WHEN wp.payment_method='transfer' THEN wp.amount ELSE 0 END),0)::numeric AS transfer_sales,
              COALESCE(SUM(CASE WHEN wp.payment_method='voucher' THEN wp.amount ELSE 0 END),0)::numeric AS voucher_sales,
              COALESCE(SUM(CASE WHEN wp.payment_method='other' THEN wp.amount ELSE 0 END),0)::numeric AS other_sales
       FROM work_order_payments wp JOIN work_orders wo ON wo.id=wp.work_order_id
       WHERE wp.paid_at::date=$1::date ${locationFilter}`, params);
    const t = totals.rows[0];
    const tipDiscount = await db.query(`SELECT COALESCE(SUM(tip_amount),0)::numeric tips, COALESCE(SUM(discount_amount),0)::numeric discounts FROM work_orders wo WHERE financial_closed_at::date=$1::date ${locationFilter}`, params);
    const expectedCash = money(openingCash + money(t.cash_sales)); const difference = money(countedCash - expectedCash);
    const { rows } = await db.query(
      `INSERT INTO cash_register_closings
       (location_id,business_date,opening_cash,cash_sales,card_sales,transfer_sales,voucher_sales,other_sales,tips,discounts,expected_cash,counted_cash,difference,note,closed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (location_id,business_date) DO UPDATE SET
         opening_cash=EXCLUDED.opening_cash,cash_sales=EXCLUDED.cash_sales,card_sales=EXCLUDED.card_sales,
         transfer_sales=EXCLUDED.transfer_sales,voucher_sales=EXCLUDED.voucher_sales,other_sales=EXCLUDED.other_sales,
         tips=EXCLUDED.tips,discounts=EXCLUDED.discounts,expected_cash=EXCLUDED.expected_cash,
         counted_cash=EXCLUDED.counted_cash,difference=EXCLUDED.difference,note=EXCLUDED.note,
         closed_by=EXCLUDED.closed_by,closed_at=now() RETURNING *`,
      [locationId,businessDate,openingCash,money(t.cash_sales),money(t.card_sales),money(t.transfer_sales),money(t.voucher_sales),money(t.other_sales), money(tipDiscount.rows[0]?.tips),money(tipDiscount.rows[0]?.discounts),expectedCash,countedCash,difference,req.body?.note || null,req.user?.email || String(req.user?.id || "")]);
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

router.get("/daily-closes", async (req: AuthRequest, res, next) => {
  try { const { rows } = await db.query(`SELECT * FROM cash_register_closings ORDER BY business_date DESC, closed_at DESC LIMIT 100`); res.json(rows); }
  catch (err) { next(err); }
});

export default router;
