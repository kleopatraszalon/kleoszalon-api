import { Router } from "express";
import PDFDocument from "pdfkit";
import db from "../db";
import { requireFeature } from "../middleware/featureAccess";

const router = Router();
router.use(requireFeature("inventory"));

const num = (v: unknown) => Number(v || 0);
const actor = (req: any) => req.user?.email || String(req.user?.id || "");
const roles = (req: any) => {
  const raw = req.user?.role;
  return (Array.isArray(raw) ? raw : String(raw || "").replace(/[\[\]"]/g, "").split(","))
    .map((x: any) => String(x).trim().toLowerCase()).filter(Boolean);
};
const canApprove = (req: any) => roles(req).some((r: string) => ["admin","manager","vezető","vezeto","owner","director"].includes(r));

async function orderTotal(orderId: string | number) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(ordered_quantity*unit_cost),0)::numeric total
     FROM purchase_order_items WHERE purchase_order_id=$1`, [orderId]
  );
  return num(rows[0]?.total);
}

router.get("/settings", async (_req, res, next) => {
  try {
    const { rows } = await db.query(`SELECT * FROM procurement_approval_settings WHERE id=1`);
    res.json(rows[0] || { approval_threshold:50000, price_variance_warning_pct:10 });
  } catch (err) { next(err); }
});

router.put("/settings", async (req: any, res, next) => {
  try {
    if (!canApprove(req)) return res.status(403).json({ message:"A jóváhagyási szabályokat csak vezető módosíthatja." });
    const threshold = Math.max(0, num(req.body?.approval_threshold));
    const variance = Math.max(0, num(req.body?.price_variance_warning_pct));
    const { rows } = await db.query(
      `INSERT INTO procurement_approval_settings(id,approval_threshold,price_variance_warning_pct,updated_by,updated_at)
       VALUES(1,$1,$2,$3,now())
       ON CONFLICT(id) DO UPDATE SET approval_threshold=EXCLUDED.approval_threshold,
         price_variance_warning_pct=EXCLUDED.price_variance_warning_pct,updated_by=EXCLUDED.updated_by,updated_at=now()
       RETURNING *`, [threshold, variance, actor(req)]
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

router.get("/pending", async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT po.*,
              COALESCE(SUM(poi.ordered_quantity*poi.unit_cost),0)::numeric AS order_total,
              COUNT(poi.id)::int AS item_count
       FROM purchase_orders po
       LEFT JOIN purchase_order_items poi ON poi.purchase_order_id=po.id
       WHERE po.approval_status='pending'
       GROUP BY po.id ORDER BY po.approval_requested_at ASC NULLS LAST, po.created_at ASC`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post("/orders/:id/request-approval", async (req: any, res, next) => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const order = await client.query(`SELECT * FROM purchase_orders WHERE id=$1 FOR UPDATE`, [req.params.id]);
    if (!order.rows[0]) { await client.query("ROLLBACK"); return res.status(404).json({message:"A rendelés nem található."}); }
    if (order.rows[0].status !== "draft") { await client.query("ROLLBACK"); return res.status(409).json({message:"Jóváhagyást csak piszkozat rendelésre lehet kérni."}); }
    const totalRes = await client.query(`SELECT COALESCE(SUM(ordered_quantity*unit_cost),0)::numeric total FROM purchase_order_items WHERE purchase_order_id=$1`, [req.params.id]);
    const total = num(totalRes.rows[0]?.total);
    const settings = await client.query(`SELECT approval_threshold FROM procurement_approval_settings WHERE id=1`);
    const threshold = num(settings.rows[0]?.approval_threshold ?? 50000);
    const auto = total <= threshold;
    const status = auto ? "auto_approved" : "pending";
    const who = actor(req);
    const { rows } = await client.query(
      `UPDATE purchase_orders SET approval_status=$2,approval_requested_at=now(),approval_requested_by=$3,
         approved_at=CASE WHEN $2='auto_approved' THEN now() ELSE NULL END,
         approved_by=CASE WHEN $2='auto_approved' THEN $3 ELSE NULL END,
         approved_total=CASE WHEN $2='auto_approved' THEN $4 ELSE NULL END,
         rejected_at=NULL,rejected_by=NULL,rejection_reason=NULL,updated_at=now()
       WHERE id=$1 RETURNING *`, [req.params.id,status,who,total]
    );
    await client.query(
      `INSERT INTO procurement_approval_events(purchase_order_id,event_type,actor_key,note,order_total)
       VALUES($1,$2,$3,$4,$5)`, [req.params.id,auto?"auto_approved":"requested",who,auto?`Automatikus jóváhagyás ${threshold} Ft értékhatárig.`:"Vezetői jóváhagyás szükséges.",total]
    );
    await client.query("COMMIT");
    res.json({ ...rows[0], order_total:total, approval_threshold:threshold });
  } catch (err) { await client.query("ROLLBACK"); next(err); }
  finally { client.release(); }
});

router.post("/orders/:id/approve", async (req: any, res, next) => {
  try {
    if (!canApprove(req)) return res.status(403).json({message:"Ehhez vezetői jogosultság szükséges."});
    const total = await orderTotal(req.params.id);
    const { rows } = await db.query(
      `UPDATE purchase_orders SET approval_status='approved',approved_at=now(),approved_by=$2,approved_total=$3,
         rejected_at=NULL,rejected_by=NULL,rejection_reason=NULL,updated_at=now()
       WHERE id=$1 AND approval_status='pending' RETURNING *`, [req.params.id,actor(req),total]
    );
    if (!rows[0]) return res.status(409).json({message:"A rendelés nem vár vezetői jóváhagyásra."});
    await db.query(`INSERT INTO procurement_approval_events(purchase_order_id,event_type,actor_key,note,order_total) VALUES($1,'approved',$2,$3,$4)`, [req.params.id,actor(req),String(req.body?.note||"").trim()||null,total]);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

router.post("/orders/:id/reject", async (req: any, res, next) => {
  try {
    if (!canApprove(req)) return res.status(403).json({message:"Ehhez vezetői jogosultság szükséges."});
    const reason = String(req.body?.reason || "").trim();
    if (!reason) return res.status(400).json({message:"Az elutasítás indoklása kötelező."});
    const total = await orderTotal(req.params.id);
    const { rows } = await db.query(
      `UPDATE purchase_orders SET approval_status='rejected',rejected_at=now(),rejected_by=$2,rejection_reason=$3,updated_at=now()
       WHERE id=$1 AND approval_status='pending' RETURNING *`, [req.params.id,actor(req),reason]
    );
    if (!rows[0]) return res.status(409).json({message:"A rendelés nem vár vezetői jóváhagyásra."});
    await db.query(`INSERT INTO procurement_approval_events(purchase_order_id,event_type,actor_key,note,order_total) VALUES($1,'rejected',$2,$3,$4)`, [req.params.id,actor(req),reason,total]);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

router.get("/orders/:id/document.pdf", async (req, res, next) => {
  try {
    const orderRes = await db.query(`SELECT po.*,s.name supplier_master_name,s.address supplier_address,s.tax_number supplier_tax_number FROM purchase_orders po LEFT JOIN suppliers s ON s.id=po.supplier_id WHERE po.id=$1`, [req.params.id]);
    const order = orderRes.rows[0];
    if (!order) return res.status(404).json({message:"A rendelés nem található."});
    const items = await db.query(`SELECT poi.*,p.name product_name,p.internal_code FROM purchase_order_items poi JOIN products p ON p.id=poi.product_id WHERE poi.purchase_order_id=$1 ORDER BY poi.id`, [req.params.id]);
    const total = items.rows.reduce((s:any,x:any)=>s+num(x.ordered_quantity)*num(x.unit_cost),0);
    let docNo = order.document_number;
    if (!docNo) {
      docNo = `PO-${new Date().getFullYear()}-${String(order.id).padStart(6,"0")}`;
      await db.query(`UPDATE purchase_orders SET document_number=$2 WHERE id=$1`, [order.id,docNo]);
      await db.query(`INSERT INTO procurement_approval_events(purchase_order_id,event_type,actor_key,note,order_total) VALUES($1,'document_generated',$2,$3,$4)`, [order.id,actor(req),docNo,total]);
    }
    res.setHeader("Content-Type","application/pdf");
    res.setHeader("Content-Disposition",`inline; filename=\"${docNo}.pdf\"`);
    const doc = new PDFDocument({ size:"A4", margin:42 });
    doc.pipe(res);
    doc.fontSize(18).text("KLEOSZALON – BESZERZÉSI RENDELÉS",{align:"center"});
    doc.moveDown().fontSize(11).text(`Bizonylatszám: ${docNo}`);
    doc.text(`Rendelés: #${order.id}`);
    doc.text(`Beszállító: ${order.supplier_master_name || order.supplier_name}`);
    if (order.supplier_address) doc.text(`Cím: ${order.supplier_address}`);
    if (order.supplier_tax_number) doc.text(`Adószám: ${order.supplier_tax_number}`);
    doc.text(`Várható érkezés: ${order.expected_at ? new Date(order.expected_at).toLocaleDateString("hu-HU") : "—"}`);
    doc.text(`Jóváhagyás: ${order.approval_status}${order.approved_by ? ` – ${order.approved_by}` : ""}`);
    doc.moveDown();
    doc.fontSize(10).text("Termék",42,190); doc.text("Menny.",300,190); doc.text("Egységár",370,190); doc.text("Érték",470,190);
    let y=210;
    for (const item of items.rows) {
      if (y>740) { doc.addPage(); y=60; }
      doc.text(`${item.product_name}${item.internal_code?` (${item.internal_code})`:""}`,42,y,{width:245});
      doc.text(String(item.ordered_quantity),300,y,{width:60,align:"right"});
      doc.text(`${num(item.unit_cost).toLocaleString("hu-HU")} Ft`,370,y,{width:85,align:"right"});
      doc.text(`${(num(item.ordered_quantity)*num(item.unit_cost)).toLocaleString("hu-HU")} Ft`,470,y,{width:85,align:"right"});
      y += 24;
    }
    doc.moveTo(42,y+6).lineTo(555,y+6).stroke();
    doc.fontSize(12).text(`Összesen: ${total.toLocaleString("hu-HU")} Ft`,350,y+16,{width:205,align:"right"});
    if (order.note) doc.fontSize(9).text(`Megjegyzés: ${order.note}`,42,y+52,{width:510});
    doc.end();
  } catch (err) { next(err); }
});

router.get("/supplier-performance", async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT s.id,s.name,
              COUNT(DISTINCT po.id) FILTER (WHERE po.status='received')::int received_orders,
              COALESCE(ROUND(100.0*COUNT(DISTINCT po.id) FILTER (WHERE po.status='received' AND (po.expected_at IS NULL OR po.received_at::date<=po.expected_at)) / NULLIF(COUNT(DISTINCT po.id) FILTER (WHERE po.status='received'),0),1),100) AS on_time_rate,
              COALESCE(ROUND(100.0*SUM(LEAST(poi.received_quantity,poi.ordered_quantity)) / NULLIF(SUM(poi.ordered_quantity),0),1),100) AS fill_rate,
              COALESCE(ROUND(AVG(CASE WHEN poi.unit_cost>0 AND poi.actual_unit_cost IS NOT NULL THEN 100.0*(poi.actual_unit_cost-poi.unit_cost)/poi.unit_cost END),2),0) AS avg_price_variance_pct,
              MAX(po.received_at) AS last_delivery_at
       FROM suppliers s
       LEFT JOIN purchase_orders po ON po.supplier_id=s.id
       LEFT JOIN purchase_order_items poi ON poi.purchase_order_id=po.id
       WHERE s.active
       GROUP BY s.id,s.name ORDER BY s.name`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get("/alerts", async (_req, res, next) => {
  try {
    const settings = await db.query(`SELECT price_variance_warning_pct FROM procurement_approval_settings WHERE id=1`);
    const limit = num(settings.rows[0]?.price_variance_warning_pct ?? 10);
    const late = await db.query(
      `SELECT po.id,po.supplier_name,po.expected_at,po.status,'late_delivery'::text type
       FROM purchase_orders po WHERE po.expected_at<CURRENT_DATE AND po.status IN ('ordered','partially_received') ORDER BY po.expected_at`
    );
    const price = await db.query(
      `SELECT po.id,po.supplier_name,p.name product_name,poi.unit_cost,poi.actual_unit_cost,
              ROUND(100.0*(poi.actual_unit_cost-poi.unit_cost)/NULLIF(poi.unit_cost,0),2) variance_pct,'price_variance'::text type
       FROM purchase_order_items poi JOIN purchase_orders po ON po.id=poi.purchase_order_id JOIN products p ON p.id=poi.product_id
       WHERE poi.actual_unit_cost IS NOT NULL AND poi.unit_cost>0 AND ABS(100.0*(poi.actual_unit_cost-poi.unit_cost)/poi.unit_cost)>=$1
       ORDER BY ABS(100.0*(poi.actual_unit_cost-poi.unit_cost)/poi.unit_cost) DESC LIMIT 100`, [limit]
    );
    res.json([...late.rows,...price.rows]);
  } catch (err) { next(err); }
});

export default router;
