import { Router } from "express";
import db from "../db";
import { requireFeature } from "../middleware/featureAccess";
import { requireMenuPermission } from "../middleware/menuPermission";

const router = Router();
router.use(requireFeature("procurement"));

const n = (v: unknown) => Number(v || 0);
const clean = (v: unknown) => String(v ?? "").trim();

router.get("/", requireMenuPermission("procurement.suppliers","can_view"), async (req, res, next) => {
  try {
    const includeInactive = String(req.query.include_inactive || "") === "1";
    const { rows } = await db.query(
      `SELECT s.*,
              COALESCE((SELECT COUNT(*) FROM product_supplier_terms pst WHERE pst.supplier_id=s.id AND pst.active),0)::int AS product_count,
              COALESCE((SELECT COUNT(*) FROM purchase_orders po WHERE po.supplier_id=s.id AND po.status NOT IN ('received','cancelled')),0)::int AS open_order_count
       FROM suppliers s
       WHERE ($1::boolean OR s.active)
       ORDER BY s.active DESC, lower(s.name)`, [includeInactive]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post("/", requireMenuPermission("procurement.suppliers","can_create"), async (req: any, res, next) => {
  try {
    const name = clean(req.body?.name);
    if (!name) return res.status(400).json({ message: "A beszállító neve kötelező." });
    const { rows } = await db.query(
      `INSERT INTO suppliers
       (name,tax_number,email,phone,contact_name,address,website,payment_terms_days,default_lead_time_days,active,note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [name,clean(req.body?.tax_number)||null,clean(req.body?.email)||null,clean(req.body?.phone)||null,
       clean(req.body?.contact_name)||null,clean(req.body?.address)||null,clean(req.body?.website)||null,
       Math.max(0,Math.trunc(n(req.body?.payment_terms_days))),Math.max(0,Math.trunc(n(req.body?.default_lead_time_days ?? 3))),
       req.body?.active !== false,clean(req.body?.note)||null]
    );
    res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err?.code === "23505") return res.status(409).json({ message: "Már létezik ilyen nevű beszállító." });
    next(err);
  }
});

router.patch("/:id", requireMenuPermission("procurement.suppliers","can_edit"), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE suppliers SET name=COALESCE(NULLIF($2,''),name),tax_number=$3,email=$4,phone=$5,contact_name=$6,
       address=$7,website=$8,payment_terms_days=$9,default_lead_time_days=$10,active=$11,note=$12,updated_at=now()
       WHERE id=$1 RETURNING *`,
      [req.params.id,clean(req.body?.name),clean(req.body?.tax_number)||null,clean(req.body?.email)||null,
       clean(req.body?.phone)||null,clean(req.body?.contact_name)||null,clean(req.body?.address)||null,
       clean(req.body?.website)||null,Math.max(0,Math.trunc(n(req.body?.payment_terms_days))),
       Math.max(0,Math.trunc(n(req.body?.default_lead_time_days ?? 3))),req.body?.active !== false,clean(req.body?.note)||null]
    );
    if (!rows[0]) return res.status(404).json({ message: "A beszállító nem található." });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

router.get("/:id/products", requireMenuPermission("procurement.prices","can_view"), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT pst.*,p.name AS product_name,p.internal_code,p.brand,
              COALESCE((SELECT COALESCE(poi.actual_unit_cost,poi.unit_cost)
                        FROM purchase_order_items poi JOIN purchase_orders po ON po.id=poi.purchase_order_id
                        WHERE poi.product_id=pst.product_id AND po.supplier_id=pst.supplier_id AND poi.received_quantity>0
                        ORDER BY COALESCE(po.received_at,po.updated_at) DESC,poi.id DESC LIMIT 1),pst.unit_price)::numeric AS last_purchase_price,
              COALESCE((SELECT AVG(COALESCE(poi.actual_unit_cost,poi.unit_cost))
                        FROM purchase_order_items poi JOIN purchase_orders po ON po.id=poi.purchase_order_id
                        WHERE poi.product_id=pst.product_id AND po.supplier_id=pst.supplier_id AND poi.received_quantity>0),pst.unit_price)::numeric AS average_purchase_price,
              (SELECT MAX(po.received_at) FROM purchase_order_items poi JOIN purchase_orders po ON po.id=poi.purchase_order_id
               WHERE poi.product_id=pst.product_id AND po.supplier_id=pst.supplier_id AND poi.received_quantity>0) AS last_received_at
       FROM product_supplier_terms pst JOIN products p ON p.id=pst.product_id
       WHERE pst.supplier_id=$1 ORDER BY pst.preferred DESC,p.name`, [req.params.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.put("/:supplierId/products/:productId", requireMenuPermission("procurement.prices","can_edit"), async (req, res, next) => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const preferred = Boolean(req.body?.preferred);
    if (preferred) await client.query(`UPDATE product_supplier_terms SET preferred=false,updated_at=now() WHERE product_id=$1`, [req.params.productId]);
    const { rows } = await client.query(
      `INSERT INTO product_supplier_terms
       (product_id,supplier_id,supplier_product_code,unit_price,minimum_order_quantity,lead_time_days,preferred,active,note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT(product_id,supplier_id) DO UPDATE SET supplier_product_code=EXCLUDED.supplier_product_code,
       unit_price=EXCLUDED.unit_price,minimum_order_quantity=EXCLUDED.minimum_order_quantity,lead_time_days=EXCLUDED.lead_time_days,
       preferred=EXCLUDED.preferred,active=EXCLUDED.active,note=EXCLUDED.note,updated_at=now() RETURNING *`,
      [req.params.productId,req.params.supplierId,clean(req.body?.supplier_product_code)||null,
       Math.max(0,n(req.body?.unit_price)),Math.max(0.001,n(req.body?.minimum_order_quantity || 1)),
       Math.max(0,Math.trunc(n(req.body?.lead_time_days ?? 3))),preferred,req.body?.active !== false,clean(req.body?.note)||null]
    );
    await client.query("COMMIT");
    res.json(rows[0]);
  } catch (err) { await client.query("ROLLBACK"); next(err); }
  finally { client.release(); }
});

router.get("/intelligence/grouped-suggestions", requireMenuPermission("procurement.suggestions","can_view"), async (req, res, next) => {
  try {
    const locationId = clean(req.query.location_id) || null;
    const { rows } = await db.query(
      `WITH need AS (
         SELECT b.id balance_id,b.product_id,b.location_id,b.quantity,b.min_quantity,b.unit_cost,
                GREATEST(b.min_quantity*2-b.quantity,0)::numeric AS base_needed
         FROM product_stock_balances b
         WHERE b.min_quantity>0 AND b.quantity<=b.min_quantity
           AND ($1::text IS NULL OR b.location_id::text=$1::text)
       ), ranked AS (
         SELECT n.*,p.name product_name,p.internal_code,p.brand,pst.supplier_id,s.name supplier_name,pst.unit_price supplier_price,
                pst.minimum_order_quantity,pst.lead_time_days,pst.preferred,
                ROW_NUMBER() OVER(PARTITION BY n.product_id ORDER BY pst.preferred DESC,pst.unit_price ASC NULLS LAST,pst.lead_time_days ASC) rn
         FROM need n JOIN products p ON p.id=n.product_id
         LEFT JOIN product_supplier_terms pst ON pst.product_id=n.product_id AND pst.active
         LEFT JOIN suppliers s ON s.id=pst.supplier_id AND s.active
       )
       SELECT *,CASE WHEN minimum_order_quantity IS NULL THEN base_needed ELSE GREATEST(base_needed,minimum_order_quantity) END::numeric AS suggested_quantity,
              (CASE WHEN minimum_order_quantity IS NULL THEN base_needed ELSE GREATEST(base_needed,minimum_order_quantity) END * COALESCE(supplier_price,unit_cost,0))::numeric AS expected_cost
       FROM ranked WHERE rn=1 OR rn IS NULL ORDER BY supplier_name NULLS LAST,product_name`, [locationId]
    );
    const groups: Record<string, any> = {};
    for (const row of rows) {
      const key = row.supplier_id ? String(row.supplier_id) : "unassigned";
      if (!groups[key]) groups[key] = { supplier_id: row.supplier_id, supplier_name: row.supplier_name || "Nincs kijelölt beszállító", total_expected_cost: 0, items: [] };
      groups[key].items.push(row);
      groups[key].total_expected_cost += n(row.expected_cost);
    }
    res.json(Object.values(groups));
  } catch (err) { next(err); }
});

export default router;
