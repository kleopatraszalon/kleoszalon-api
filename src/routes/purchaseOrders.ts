import { Router } from "express";
import db from "../db";
import { requireFeature } from "../middleware/featureAccess";

const router = Router();
router.use(requireFeature("inventory"));

const num = (v: unknown) => Number(v || 0);
const money = (v: unknown) => Math.round(num(v) * 100) / 100;

async function createOrder(req: any, res: any, next: any) {
  const client = await db.connect();
  try {
    const supplierName = String(req.body?.supplier_name || "").trim();
    const locationId = req.body?.location_id == null || req.body.location_id === "" ? null : String(req.body.location_id);
    const expectedAt = req.body?.expected_at || null;
    const note = String(req.body?.note || "").trim() || null;
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!supplierName) return res.status(400).json({ message: "A beszállító megadása kötelező." });
    if (!items.length) return res.status(400).json({ message: "Legalább egy rendelési tétel szükséges." });

    await client.query("BEGIN");
    const createdBy = req.user?.email || String(req.user?.id || "");
    const order = await client.query(
      `INSERT INTO purchase_orders (location_id,supplier_name,status,expected_at,note,created_by)
       VALUES ($1,$2,'draft',$3,$4,$5) RETURNING *`,
      [locationId, supplierName, expectedAt, note, createdBy]
    );

    for (const item of items) {
      const productId = String(item?.product_id || "");
      const qty = num(item?.ordered_quantity);
      const unitCost = money(item?.unit_cost);
      if (!productId || !(qty > 0) || unitCost < 0) throw new Error("Érvénytelen rendelési tétel.");
      await client.query(
        `INSERT INTO purchase_order_items (purchase_order_id,product_id,ordered_quantity,unit_cost,note)
         VALUES ($1,$2,$3,$4,$5)`,
        [order.rows[0].id, productId, qty, unitCost, item?.note || null]
      );
    }

    await client.query("COMMIT");
    return res.status(201).json(order.rows[0]);
  } catch (err: any) {
    await client.query("ROLLBACK");
    if (String(err?.message || "").startsWith("Érvénytelen rendelési")) return res.status(400).json({ message: err.message });
    return next(err);
  } finally {
    client.release();
  }
}

router.get("/suggestions", async (req, res, next) => {
  try {
    const locationId = String(req.query.location_id || "").trim() || null;
    const { rows } = await db.query(
      `SELECT b.id AS balance_id, b.product_id::text, p.name AS product_name,
              p.internal_code, p.brand, b.location_id::text,
              b.quantity::numeric AS current_quantity,
              COALESCE(b.min_quantity,0)::numeric AS min_quantity,
              COALESCE(b.unit_cost,0)::numeric AS unit_cost,
              GREATEST(COALESCE(b.min_quantity,0) * 2 - COALESCE(b.quantity,0), 0)::numeric AS suggested_quantity,
              (GREATEST(COALESCE(b.min_quantity,0) * 2 - COALESCE(b.quantity,0), 0) * COALESCE(b.unit_cost,0))::numeric AS expected_cost
       FROM product_stock_balances b
       JOIN products p ON p.id=b.product_id
       WHERE COALESCE(b.quantity,0) <= COALESCE(b.min_quantity,0)
         AND COALESCE(b.min_quantity,0) > 0
         AND ($1::text IS NULL OR b.location_id::text=$1::text)
       ORDER BY (COALESCE(b.min_quantity,0)-COALESCE(b.quantity,0)) DESC, p.name`,
      [locationId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get("/orders", async (req, res, next) => {
  try {
    const locationId = String(req.query.location_id || "").trim() || null;
    const status = String(req.query.status || "").trim() || null;
    const { rows } = await db.query(
      `SELECT po.*,
              COALESCE((SELECT SUM(poi.ordered_quantity*poi.unit_cost) FROM purchase_order_items poi WHERE poi.purchase_order_id=po.id),0)::numeric AS expected_total,
              COALESCE((SELECT SUM(poi.received_quantity*poi.unit_cost) FROM purchase_order_items poi WHERE poi.purchase_order_id=po.id),0)::numeric AS received_total,
              COALESCE((SELECT COUNT(*) FROM purchase_order_items poi WHERE poi.purchase_order_id=po.id),0)::int AS item_count
       FROM purchase_orders po
       WHERE ($1::text IS NULL OR po.location_id::text=$1::text)
         AND ($2::text IS NULL OR po.status=$2::text)
       ORDER BY po.created_at DESC
       LIMIT 200`,
      [locationId, status]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get("/orders/:id", async (req, res, next) => {
  try {
    const order = await db.query(`SELECT * FROM purchase_orders WHERE id=$1`, [req.params.id]);
    if (!order.rows[0]) return res.status(404).json({ message: "A beszerzési rendelés nem található." });
    const items = await db.query(
      `SELECT poi.*, p.name AS product_name, p.internal_code, p.brand
       FROM purchase_order_items poi JOIN products p ON p.id=poi.product_id
       WHERE poi.purchase_order_id=$1 ORDER BY poi.id`, [req.params.id]
    );
    res.json({ ...order.rows[0], items: items.rows });
  } catch (err) { next(err); }
});

router.post("/orders", createOrder);

router.post("/orders/from-suggestion", async (req: any, res, next) => {
  try {
    const balanceId = String(req.body?.balance_id || "");
    const supplierName = String(req.body?.supplier_name || "").trim();
    if (!balanceId || !supplierName) return res.status(400).json({ message: "balance_id és supplier_name szükséges." });

    const suggestion = await db.query(
      `SELECT b.product_id, b.location_id, COALESCE(b.unit_cost,0)::numeric AS unit_cost,
              GREATEST(COALESCE(b.min_quantity,0)*2-COALESCE(b.quantity,0),0)::numeric AS suggested_quantity
       FROM product_stock_balances b WHERE b.id=$1`, [balanceId]
    );
    const s = suggestion.rows[0];
    if (!s || num(s.suggested_quantity) <= 0) return res.status(400).json({ message: "Ehhez a készlethez nincs utánrendelési igény." });

    req.body = {
      location_id: s.location_id,
      supplier_name: supplierName,
      expected_at: req.body?.expected_at || null,
      note: req.body?.note || "Automatikus utánrendelési javaslatból",
      items: [{ product_id: s.product_id, ordered_quantity: num(s.suggested_quantity), unit_cost: num(s.unit_cost) }],
    };

    return createOrder(req, res, next);
  } catch (err) { next(err); }
});

router.patch("/orders/:id/status", async (req: any, res, next) => {
  try {
    const status = String(req.body?.status || "").trim();
    const allowed = ["draft","ordered","partially_received","received","cancelled"];
    if (!allowed.includes(status)) return res.status(400).json({ message: "Érvénytelen rendelési státusz." });
    const actor = req.user?.email || String(req.user?.id || "");
    const { rows } = await db.query(
      `UPDATE purchase_orders SET status=$2,
        ordered_at=CASE WHEN $2='ordered' THEN COALESCE(ordered_at,now()) ELSE ordered_at END,
        cancelled_at=CASE WHEN $2='cancelled' THEN COALESCE(cancelled_at,now()) ELSE cancelled_at END,
        updated_by=$3, updated_at=now()
       WHERE id=$1 RETURNING *`, [req.params.id, status, actor]
    );
    if (!rows[0]) return res.status(404).json({ message: "A rendelés nem található." });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

router.post("/orders/:id/receive", async (req: any, res, next) => {
  const client = await db.connect();
  try {
    const incoming = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!incoming.length) return res.status(400).json({ message: "Nincs bevételezendő tétel." });
    await client.query("BEGIN");
    const orderRes = await client.query(`SELECT * FROM purchase_orders WHERE id=$1 FOR UPDATE`, [req.params.id]);
    const order = orderRes.rows[0];
    if (!order) { await client.query("ROLLBACK"); return res.status(404).json({ message: "A rendelés nem található." }); }
    if (["received","cancelled"].includes(order.status)) { await client.query("ROLLBACK"); return res.status(409).json({ message: "Ez a rendelés már nem bevételezhető." }); }
    const actor = req.user?.email || String(req.user?.id || "");

    for (const x of incoming) {
      const itemId = String(x?.item_id || "");
      const receiveQty = num(x?.received_quantity);
      const actualUnitCost = x?.unit_cost == null || x.unit_cost === "" ? null : money(x.unit_cost);
      if (!itemId || !(receiveQty > 0)) throw new Error("Érvénytelen bevételezési tétel.");
      const itemRes = await client.query(`SELECT * FROM purchase_order_items WHERE id=$1 AND purchase_order_id=$2 FOR UPDATE`, [itemId, req.params.id]);
      const item = itemRes.rows[0];
      if (!item) throw new Error("A rendelési tétel nem található.");
      const remaining = num(item.ordered_quantity) - num(item.received_quantity);
      if (receiveQty > remaining + 0.0001) throw new Error("A bevételezett mennyiség nagyobb a hátralévő rendelésnél.");
      const cost = actualUnitCost == null ? num(item.unit_cost) : actualUnitCost;
      const balRes = await client.query(
        `SELECT * FROM product_stock_balances WHERE product_id=$1 AND (($2::text IS NULL AND location_id IS NULL) OR location_id::text=$2::text) FOR UPDATE`,
        [item.product_id, order.location_id]
      );
      const bal = balRes.rows[0];
      const oldQty = num(bal?.quantity);
      const oldCost = num(bal?.unit_cost);
      const newQty = oldQty + receiveQty;
      const newCost = newQty > 0 ? money((oldQty*oldCost + receiveQty*cost)/newQty) : cost;
      if (bal) await client.query(`UPDATE product_stock_balances SET quantity=$2,unit_cost=$3,updated_at=now() WHERE id=$1`, [bal.id,newQty,newCost]);
      else await client.query(`INSERT INTO product_stock_balances (product_id,location_id,quantity,unit_cost,min_quantity,updated_at) VALUES ($1,$2,$3,$4,0,now())`, [item.product_id,order.location_id,newQty,newCost]);
      await client.query(`UPDATE purchase_order_items SET received_quantity=received_quantity+$2, actual_unit_cost=$3, updated_at=now() WHERE id=$1`, [itemId,receiveQty,cost]);
      await client.query(
        `INSERT INTO inventory_movements (product_id,location_id,movement_type,quantity,balance_after,unit_cost,stock_value_after,note,created_by)
         VALUES ($1,$2,'receipt',$3,$4,$5,$6,$7,$8)`,
        [item.product_id,order.location_id,receiveQty,newQty,newCost,money(newQty*newCost),`Beszerzési rendelés #${order.id}`,actor]
      );
    }

    const totals = await client.query(
      `SELECT BOOL_AND(received_quantity >= ordered_quantity) AS all_received,
              BOOL_OR(received_quantity > 0) AS any_received
       FROM purchase_order_items WHERE purchase_order_id=$1`, [req.params.id]
    );
    const newStatus = totals.rows[0]?.all_received ? "received" : totals.rows[0]?.any_received ? "partially_received" : order.status;
    await client.query(
      `UPDATE purchase_orders SET status=$2, received_at=CASE WHEN $2='received' THEN now() ELSE received_at END, updated_by=$3,updated_at=now() WHERE id=$1`,
      [req.params.id,newStatus,actor]
    );
    await client.query("COMMIT");
    res.json({ ok:true, status:newStatus });
  } catch (err:any) {
    await client.query("ROLLBACK");
    const msg=String(err?.message||"");
    if (msg.startsWith("Érvénytelen") || msg.startsWith("A rendelési") || msg.startsWith("A bevételezett")) return res.status(400).json({message:msg});
    next(err);
  } finally { client.release(); }
});

export default router;
