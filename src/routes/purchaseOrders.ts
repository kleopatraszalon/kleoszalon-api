import { Router } from "express";
import db from "../db";
import { requireFeature } from "../middleware/featureAccess";
import { ensureInventoryOperationsSchema } from "../inventory/ensureInventoryOperationsSchema";
import { postWarehouseReceipt, resolveInventoryWarehouse } from "../inventory/inventoryLedgerService";

const router = Router();
router.use(requireFeature("inventory"));

const num = (v: unknown) => Number(v || 0);
const money = (v: unknown) => Math.round(num(v) * 100) / 100;

async function createOrder(req: any, res: any, next: any) {
  const client = await db.connect();
  try {
    const supplierId = req.body?.supplier_id == null || req.body.supplier_id === "" ? null : Number(req.body.supplier_id);
    let supplierName = String(req.body?.supplier_name || "").trim();
    const locationId = req.body?.location_id == null || req.body.location_id === "" ? null : String(req.body.location_id);
    const expectedAt = req.body?.expected_at || null;
    const note = String(req.body?.note || "").trim() || null;
    const items = Array.isArray(req.body?.items) ? req.body.items : [];

    await client.query("BEGIN");
    if (supplierId) {
      const supplier = await client.query(`SELECT id,name FROM suppliers WHERE id=$1 AND active`, [supplierId]);
      if (!supplier.rows[0]) throw new Error("A kiválasztott beszállító nem található vagy inaktív.");
      supplierName = supplier.rows[0].name;
    }
    if (!supplierName) throw new Error("A beszállító megadása kötelező.");
    if (!items.length) throw new Error("Legalább egy rendelési tétel szükséges.");

    const createdBy = req.user?.email || String(req.user?.id || "");
    const order = await client.query(
      `INSERT INTO purchase_orders (location_id,supplier_id,supplier_name,status,expected_at,note,created_by,approval_status)
       VALUES ($1,$2,$3,'draft',$4,$5,$6,'not_requested') RETURNING *`,
      [locationId, supplierId, supplierName, expectedAt, note, createdBy]
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
    const msg = String(err?.message || "");
    if (msg.startsWith("A beszállító") || msg.startsWith("A kiválasztott") || msg.startsWith("Legalább") || msg.startsWith("Érvénytelen")) return res.status(400).json({ message: msg });
    return next(err);
  } finally { client.release(); }
}

router.get("/suggestions", async (req, res, next) => {
  try {
    const locationId = String(req.query.location_id || "").trim() || null;
    const { rows } = await db.query(
      `WITH need AS (
         SELECT b.id AS balance_id,b.product_id,b.location_id,b.quantity,b.min_quantity,b.unit_cost,
                GREATEST(b.min_quantity*2-b.quantity,0)::numeric AS base_needed
         FROM product_stock_balances b
         WHERE b.min_quantity>0 AND b.quantity<=b.min_quantity
           AND ($1::text IS NULL OR b.location_id::text=$1::text)
       ), preferred AS (
         SELECT DISTINCT ON (pst.product_id)
                pst.product_id,pst.supplier_id,s.name supplier_name,pst.unit_price,pst.minimum_order_quantity,pst.lead_time_days,pst.preferred
         FROM product_supplier_terms pst JOIN suppliers s ON s.id=pst.supplier_id
         WHERE pst.active AND s.active
         ORDER BY pst.product_id,pst.preferred DESC,pst.unit_price ASC,pst.lead_time_days ASC
       )
       SELECT n.balance_id,n.product_id::text,p.name AS product_name,p.internal_code,p.brand,n.location_id::text,
              n.quantity::numeric AS current_quantity,n.min_quantity::numeric AS min_quantity,
              COALESCE(pr.unit_price,n.unit_cost,0)::numeric AS unit_cost,
              pr.supplier_id,pr.supplier_name,pr.minimum_order_quantity,pr.lead_time_days,pr.preferred,
              CASE WHEN pr.minimum_order_quantity IS NULL THEN n.base_needed ELSE GREATEST(n.base_needed,pr.minimum_order_quantity) END::numeric AS suggested_quantity,
              (CASE WHEN pr.minimum_order_quantity IS NULL THEN n.base_needed ELSE GREATEST(n.base_needed,pr.minimum_order_quantity) END * COALESCE(pr.unit_price,n.unit_cost,0))::numeric AS expected_cost
       FROM need n JOIN products p ON p.id=n.product_id LEFT JOIN preferred pr ON pr.product_id=n.product_id
       ORDER BY pr.supplier_name NULLS LAST,p.name`, [locationId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get("/orders", async (req, res, next) => {
  try {
    const locationId = String(req.query.location_id || "").trim() || null;
    const status = String(req.query.status || "").trim() || null;
    const { rows } = await db.query(
      `SELECT po.*,COALESCE(s.name,po.supplier_name) AS supplier_display_name,
              COALESCE((SELECT SUM(poi.ordered_quantity*poi.unit_cost) FROM purchase_order_items poi WHERE poi.purchase_order_id=po.id),0)::numeric AS expected_total,
              COALESCE((SELECT SUM(poi.received_quantity*COALESCE(poi.actual_unit_cost,poi.unit_cost)) FROM purchase_order_items poi WHERE poi.purchase_order_id=po.id),0)::numeric AS received_total,
              COALESCE((SELECT COUNT(*) FROM purchase_order_items poi WHERE poi.purchase_order_id=po.id),0)::int AS item_count
       FROM purchase_orders po LEFT JOIN suppliers s ON s.id=po.supplier_id
       WHERE ($1::text IS NULL OR po.location_id::text=$1::text) AND ($2::text IS NULL OR po.status=$2::text)
       ORDER BY po.created_at DESC LIMIT 200`, [locationId,status]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get("/orders/:id", async (req, res, next) => {
  try {
    const order = await db.query(`SELECT po.*,COALESCE(s.name,po.supplier_name) supplier_display_name FROM purchase_orders po LEFT JOIN suppliers s ON s.id=po.supplier_id WHERE po.id=$1`, [req.params.id]);
    if (!order.rows[0]) return res.status(404).json({ message: "A beszerzési rendelés nem található." });
    const items = await db.query(`SELECT poi.*,p.name AS product_name,p.internal_code,p.brand FROM purchase_order_items poi JOIN products p ON p.id=poi.product_id WHERE poi.purchase_order_id=$1 ORDER BY poi.id`, [req.params.id]);
    res.json({ ...order.rows[0], items: items.rows });
  } catch (err) { next(err); }
});

router.post("/orders", createOrder);

router.patch("/orders/:id/status", async (req: any, res, next) => {
  const client = await db.connect();
  try {
    const status = String(req.body?.status || "").trim();
    const allowed = ["draft","ordered","partially_received","received","cancelled"];
    if (!allowed.includes(status)) return res.status(400).json({ message: "Érvénytelen rendelési státusz." });
    await client.query("BEGIN");
    const current = await client.query(`SELECT * FROM purchase_orders WHERE id=$1 FOR UPDATE`, [req.params.id]);
    if (!current.rows[0]) { await client.query("ROLLBACK"); return res.status(404).json({ message: "A rendelés nem található." }); }
    if (status === "ordered" && !["approved","auto_approved"].includes(String(current.rows[0].approval_status || ""))) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "A rendelés csak jóváhagyás után küldhető rendelésre.", approval_status: current.rows[0].approval_status });
    }
    const who = req.user?.email || String(req.user?.id || "");
    const { rows } = await client.query(
      `UPDATE purchase_orders SET status=$2,
       ordered_at=CASE WHEN $2='ordered' THEN COALESCE(ordered_at,now()) ELSE ordered_at END,
       cancelled_at=CASE WHEN $2='cancelled' THEN COALESCE(cancelled_at,now()) ELSE cancelled_at END,
       updated_by=$3,updated_at=now() WHERE id=$1 RETURNING *`, [req.params.id,status,who]
    );
    if (status === "ordered") {
      const total = await client.query(`SELECT COALESCE(SUM(ordered_quantity*unit_cost),0)::numeric total FROM purchase_order_items WHERE purchase_order_id=$1`, [req.params.id]);
      await client.query(`INSERT INTO procurement_approval_events(purchase_order_id,event_type,actor_key,note,order_total) VALUES($1,'ordered',$2,'Rendelésre küldve',$3)`, [req.params.id,who,num(total.rows[0]?.total)]);
    }
    await client.query("COMMIT");
    res.json(rows[0]);
  } catch (err) { await client.query("ROLLBACK"); next(err); }
  finally { client.release(); }
});

router.post("/orders/:id/receive", async (req: any, res, next) => {
  const client = await db.connect();
  try {
    const incoming = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!incoming.length) return res.status(400).json({ message: "Nincs bevételezendő tétel." });
    await ensureInventoryOperationsSchema();
    await client.query("BEGIN");
    const orderRes = await client.query(`SELECT * FROM purchase_orders WHERE id=$1 FOR UPDATE`, [req.params.id]);
    const order = orderRes.rows[0];
    if (!order) { await client.query("ROLLBACK"); return res.status(404).json({ message: "A rendelés nem található." }); }
    if (!["ordered","partially_received"].includes(order.status)) { await client.query("ROLLBACK"); return res.status(409).json({ message: "Bevételezés csak megrendelt vagy részben beérkezett rendelésre végezhető." }); }
    const who = req.user?.email || String(req.user?.id || "");
    const receipts:any[]=[];

    for (const x of incoming) {
      const itemId = String(x?.item_id || "");
      const receiveQty = num(x?.received_quantity);
      const actualUnitCost = x?.unit_cost == null || x.unit_cost === "" ? null : money(x.unit_cost);
      if (!itemId || !(receiveQty > 0)) throw new Error("Érvénytelen bevételezési tétel.");
      if (actualUnitCost != null && actualUnitCost < 0) throw new Error("Érvénytelen bevételezési egységár.");
      const itemRes = await client.query(`SELECT * FROM purchase_order_items WHERE id=$1 AND purchase_order_id=$2 FOR UPDATE`, [itemId,req.params.id]);
      const item = itemRes.rows[0];
      if (!item) throw new Error("A rendelési tétel nem található.");
      const remaining = num(item.ordered_quantity)-num(item.received_quantity);
      if (receiveQty>remaining+0.0001) throw new Error("A bevételezett mennyiség nagyobb a hátralévő rendelésnél.");
      const cost = actualUnitCost == null ? num(item.unit_cost) : actualUnitCost;
      const locationId = order.location_id == null ? null : String(order.location_id);
      const warehouse = await resolveInventoryWarehouse(client, {
        locationId,
        productId:String(item.product_id),
        warehouseId:x?.warehouse_id ?? req.body?.warehouse_id ?? null,
      });
      const receipt = await postWarehouseReceipt(client, {
        warehouse,
        productId:String(item.product_id),
        quantity:receiveQty,
        incomingUnitCost:cost,
        movementType:"receipt",
        meta:{
          supplierId:order.supplier_id || null,
          documentNumber:`PO-${order.id}`,
          counterpartyName:order.supplier_name || null,
          note:`Beszerzési rendelés #${order.id}`,
          createdBy:who,
        },
      });
      receipts.push({item_id:itemId,product_id:String(item.product_id),...receipt});
      await client.query(`UPDATE purchase_order_items SET received_quantity=received_quantity+$2,actual_unit_cost=$3,updated_at=now() WHERE id=$1`, [itemId,receiveQty,cost]);
      if (order.supplier_id) await client.query(`UPDATE product_supplier_terms SET unit_price=$3,updated_at=now() WHERE product_id=$1 AND supplier_id=$2`, [item.product_id,order.supplier_id,cost]);
    }

    const totals = await client.query(`SELECT BOOL_AND(received_quantity>=ordered_quantity) all_received,BOOL_OR(received_quantity>0) any_received FROM purchase_order_items WHERE purchase_order_id=$1`, [req.params.id]);
    const newStatus = totals.rows[0]?.all_received ? "received" : totals.rows[0]?.any_received ? "partially_received" : order.status;
    await client.query(`UPDATE purchase_orders SET status=$2,received_at=CASE WHEN $2='received' THEN now() ELSE received_at END,updated_by=$3,updated_at=now() WHERE id=$1`, [req.params.id,newStatus,who]);
    await client.query("COMMIT");
    res.json({ ok:true,status:newStatus,receipts });
  } catch (err:any) {
    await client.query("ROLLBACK").catch(()=>undefined);
    const msg=String(err?.message||"");
    if (err?.status) return res.status(Number(err.status)).json({message:msg,code:err.code||err.publicCode});
    if (msg.startsWith("Érvénytelen") || msg.startsWith("A rendelési") || msg.startsWith("A bevételezett")) return res.status(400).json({message:msg});
    next(err);
  } finally { client.release(); }
});

export default router;
