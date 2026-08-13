import { Router } from "express";
import { randomUUID } from "crypto";
import db from "../db";
import { ensureInventoryOperationsSchema } from "../inventory/ensureInventoryOperationsSchema";
import { hasAnyRole } from "../security/roles";

const router = Router();
const EPS = 0.0001;

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const money = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};
const actor = (req: any) => req.user?.email || String(req.user?.id || "");
const isGlobal = (req: any) => hasAnyRole(req.user?.role, ["admin", "manager"]);
const canOperate = (req: any) => hasAnyRole(req.user?.role, ["admin", "manager", "location_manager", "salon_manager", "receptionist"]);
const canApprove = (req: any) => hasAnyRole(req.user?.role, ["admin", "manager", "location_manager"]);
const canConfigure = (req: any) => hasAnyRole(req.user?.role, ["admin", "manager", "location_manager"]);
const canMasterData = (req: any) => hasAnyRole(req.user?.role, ["admin", "manager"]);
const ownLocation = (req: any) => req.user?.location_id == null ? null : String(req.user.location_id);
const locationKey = (locationId: string | null) => locationId || "__central__";

function fail(status: number, message: string, code?: string): never {
  const err: any = new Error(message);
  err.status = status;
  err.publicCode = code;
  throw err;
}
function sendError(err: any, res: any, next: any) {
  if (err?.status) return res.status(err.status).json({ message: err.message, code: err.publicCode });
  return next(err);
}
function ensureOperator(req: any) {
  if (!canOperate(req)) fail(403, "Nincs jogosultsága készletművelet végrehajtásához.", "inventory_operation_forbidden");
}
function ensureWarehouseScope(req: any, warehouse: any) {
  if (isGlobal(req)) return;
  const own = ownLocation(req);
  const whLocation = warehouse?.location_id == null ? null : String(warehouse.location_id);
  if (!own || whLocation !== own) fail(403, "Ehhez a raktárhoz nincs jogosultsága.", "inventory_warehouse_forbidden");
}
function ensureWarehouseManageScope(req: any, warehouse: any) {
  if (!canConfigure(req)) fail(403, "Nincs jogosultsága raktárbeállítások módosításához.");
  if (isGlobal(req)) return;
  ensureWarehouseScope(req, warehouse);
}

async function warehouseById(id: unknown, client: any = db, forUpdate = false) {
  const raw = String(id ?? "").trim();
  if (!raw) fail(400, "A raktár megadása kötelező.");
  const { rows } = await client.query(`SELECT * FROM inventory_warehouses WHERE id=$1 ${forUpdate ? "FOR UPDATE" : ""}`, [raw]);
  if (!rows[0]) fail(404, "A raktár nem található.");
  return rows[0];
}

async function inventorySetting(locationId: string | null, client: any = db) {
  const key = locationKey(locationId);
  const { rows } = await client.query(`
    SELECT
      COALESCE(local.cost_method,global.cost_method,'weighted_average') AS cost_method,
      COALESCE(local.prevent_negative_stock,global.prevent_negative_stock,true) AS prevent_negative_stock,
      COALESCE(local.stocktake_missing_mode,global.stocktake_missing_mode,'system') AS stocktake_missing_mode,
      COALESCE(local.barcode_increment,global.barcode_increment,1)::numeric AS barcode_increment,
      $1::text AS location_key
    FROM (SELECT * FROM inventory_settings WHERE location_key='__global__') global
    LEFT JOIN inventory_settings local ON local.location_key=$1
  `, [key]);
  return rows[0] || { cost_method: "weighted_average", prevent_negative_stock: true, stocktake_missing_mode: "system", barcode_increment: 1, location_key: key };
}

async function balanceForUpdate(client: any, warehouseId: string | number, productId: string) {
  await client.query(`INSERT INTO inventory_warehouse_balances(warehouse_id,product_id,quantity,min_quantity,optimal_quantity,unit_cost)
    VALUES($1,$2::uuid,0,0,0,0) ON CONFLICT(warehouse_id,product_id) DO NOTHING`, [warehouseId, productId]);
  const { rows } = await client.query(`SELECT * FROM inventory_warehouse_balances WHERE warehouse_id=$1 AND product_id=$2::uuid FOR UPDATE`, [warehouseId, productId]);
  return rows[0];
}

async function productCost(client: any, productId: string) {
  const { rows } = await client.query(`SELECT COALESCE(NULLIF(to_jsonb(p)->>'purchase_price_net','')::numeric,0)::numeric AS cost FROM products p WHERE id=$1::uuid`, [productId]);
  return Number(rows[0]?.cost || 0);
}

async function syncLegacyAggregate(client: any, productId: string, locationId: string | null) {
  const aggregate = await client.query(`
    SELECT COALESCE(SUM(b.quantity),0)::numeric AS quantity,
           COALESCE(SUM(b.min_quantity),0)::numeric AS min_quantity,
           COALESCE(SUM(b.optimal_quantity),0)::numeric AS optimal_quantity,
           CASE WHEN SUM(CASE WHEN b.quantity>0 THEN b.quantity ELSE 0 END)>0
                THEN SUM(CASE WHEN b.quantity>0 THEN b.quantity*b.unit_cost ELSE 0 END)/SUM(CASE WHEN b.quantity>0 THEN b.quantity ELSE 0 END)
                ELSE COALESCE(MAX(b.unit_cost),0) END::numeric AS unit_cost
    FROM inventory_warehouse_balances b
    JOIN inventory_warehouses w ON w.id=b.warehouse_id AND w.active=true
    WHERE b.product_id=$1::uuid AND (($2::text IS NULL AND w.location_id IS NULL) OR w.location_id=$2::text)
  `, [productId, locationId]);
  const a = aggregate.rows[0] || {};
  await client.query(`SELECT set_config('kleo.inventory_sync','warehouse_to_legacy',true)`);
  const existing = await client.query(`SELECT id FROM product_stock_balances WHERE product_id=$1::uuid AND (($2::text IS NULL AND location_id IS NULL) OR location_id::text=$2::text) LIMIT 1 FOR UPDATE`, [productId, locationId]);
  if (existing.rows[0]) {
    await client.query(`UPDATE product_stock_balances SET quantity=$2,min_quantity=$3,optimal_quantity=$4,unit_cost=$5,updated_at=now() WHERE id=$1`, [existing.rows[0].id, Number(a.quantity || 0), Number(a.min_quantity || 0), Number(a.optimal_quantity || 0), money(a.unit_cost)]);
  } else {
    await client.query(`INSERT INTO product_stock_balances(product_id,location_id,quantity,min_quantity,optimal_quantity,unit_cost,updated_at) VALUES($1::uuid,$2,$3,$4,$5,$6,now())`, [productId, locationId, Number(a.quantity || 0), Number(a.min_quantity || 0), Number(a.optimal_quantity || 0), money(a.unit_cost)]);
  }
}

async function addMovement(client: any, params: {
  productId: string;
  warehouse: any;
  movementType: string;
  quantity: number;
  balanceAfter: number;
  unitCost: number;
  note?: string | null;
  createdBy: string;
  operationGroupId?: string | null;
  destinationWarehouseId?: string | number | null;
  supplierId?: string | number | null;
  documentNumber?: string | null;
  counterpartyName?: string | null;
}) {
  await client.query(`
    INSERT INTO inventory_movements(product_id,location_id,movement_type,quantity,balance_after,unit_cost,stock_value_after,note,created_by,
      warehouse_id,destination_warehouse_id,supplier_id,document_number,operation_group_id,counterparty_name)
    VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::uuid,$15)
  `, [
    params.productId, params.warehouse.location_id, params.movementType, params.quantity, params.balanceAfter,
    params.unitCost, money(params.balanceAfter * params.unitCost), params.note || null, params.createdBy,
    params.warehouse.id, params.destinationWarehouseId || null, params.supplierId || null, params.documentNumber || null,
    params.operationGroupId || null, params.counterpartyName || null,
  ]);
}

async function updateWarehouseDefaults(client: any, warehouse: any, sale: boolean, consumption: boolean) {
  if (sale) await client.query(`UPDATE inventory_warehouses SET is_default_sale=false,updated_at=now() WHERE id<>$1 AND (($2::text IS NULL AND location_id IS NULL) OR location_id=$2::text)`, [warehouse.id, warehouse.location_id]);
  if (consumption) await client.query(`UPDATE inventory_warehouses SET is_default_consumption=false,updated_at=now() WHERE id<>$1 AND (($2::text IS NULL AND location_id IS NULL) OR location_id=$2::text)`, [warehouse.id, warehouse.location_id]);
}

router.use(async (_req, _res, next) => {
  try { await ensureInventoryOperationsSchema(); next(); } catch (err) { next(err); }
});

router.use((req: any, res, next) => {
  if (hasAnyRole(req.user?.role, ["admin", "manager", "location_manager", "salon_manager", "receptionist"])) return next();
  return res.status(403).json({ message: "Ehhez a készletgazdálkodási modulhoz nincs jogosultsága.", code: "inventory_operations_forbidden" });
});

router.get("/warehouses", async (req: any, res, next) => {
  try {
    const params: any[] = [];
    const filters = ["w.active=true"];
    if (!isGlobal(req)) {
      const own = ownLocation(req);
      if (!own) return res.json([]);
      params.push(own); filters.push(`w.location_id=$${params.length}::text`);
    } else if (req.query.location_id !== undefined) {
      const locationId = String(req.query.location_id || "").trim() || null;
      if (locationId === null) filters.push("w.location_id IS NULL");
      else { params.push(locationId); filters.push(`w.location_id=$${params.length}::text`); }
    }
    const { rows } = await db.query(`SELECT w.*,l.name AS location_name,
      COALESCE((SELECT COUNT(*) FROM inventory_warehouse_balances b WHERE b.warehouse_id=w.id),0)::int AS product_count,
      COALESCE((SELECT SUM(b.quantity*b.unit_cost) FROM inventory_warehouse_balances b WHERE b.warehouse_id=w.id),0)::numeric AS stock_value
      FROM inventory_warehouses w LEFT JOIN locations l ON l.id::text=w.location_id
      WHERE ${filters.join(" AND ")} ORDER BY COALESCE(l.name,'Központ'),w.sort_order,w.name`, params);
    res.json(rows);
  } catch (err) { sendError(err, res, next); }
});

router.get("/catalog/products", async (_req, res, next) => {
  try {
    const { rows } = await db.query(`SELECT p.id::text,p.name,p.internal_code,p.barcode,p.brand,p.product_category_id::text,c.name AS product_category_name FROM products p LEFT JOIN product_categories c ON c.id=p.product_category_id WHERE COALESCE(p.is_active,true)=true ORDER BY p.name`);
    res.json(rows);
  } catch (err) { next(err); }
});

router.get("/catalog/categories", async (_req, res, next) => {
  try {
    const { rows } = await db.query(`SELECT c.id::text,c.name,c.product_group_id::text,g.name AS product_group_name FROM product_categories c LEFT JOIN product_groups g ON g.id=c.product_group_id WHERE COALESCE(c.is_active,true)=true ORDER BY COALESCE(g.sort_order,999),COALESCE(c.sort_order,999),c.name`);
    res.json(rows);
  } catch (err) { next(err); }
});

router.get("/transfer-targets", async (req: any, res, next) => {
  try {
    ensureOperator(req);
    const { rows } = await db.query(`SELECT w.id,w.name,w.location_id,l.name AS location_name,w.warehouse_type FROM inventory_warehouses w LEFT JOIN locations l ON l.id::text=w.location_id WHERE w.active=true ORDER BY COALESCE(l.name,'Központ'),w.sort_order,w.name`);
    res.json(rows);
  } catch (err) { sendError(err, res, next); }
});

router.post("/warehouses", async (req: any, res, next) => {
  const client = await db.connect();
  try {
    if (!canConfigure(req)) fail(403, "Nincs jogosultsága raktár létrehozásához.");
    const locationId = String(req.body?.location_id || "").trim() || null;
    if (!isGlobal(req) && locationId !== ownLocation(req)) fail(403, "Csak a saját telephelyén hozhat létre raktárt.");
    const name = String(req.body?.name || "").trim();
    const type = String(req.body?.warehouse_type || "mixed").trim();
    if (!name) fail(400, "A raktár neve kötelező.");
    if (!["retail","consumable","mixed","transit"].includes(type)) fail(400, "Érvénytelen raktártípus.");
    const sale = Boolean(req.body?.is_default_sale);
    const consumption = Boolean(req.body?.is_default_consumption);
    await client.query("BEGIN");
    const { rows } = await client.query(`INSERT INTO inventory_warehouses(location_id,code,name,warehouse_type,comment,is_default_sale,is_default_consumption,sort_order,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`, [locationId, String(req.body?.code || "").trim() || null, name, type, String(req.body?.comment || "").trim() || null, sale, consumption, Number(req.body?.sort_order || 100), actor(req)]);
    await updateWarehouseDefaults(client, rows[0], sale, consumption);
    await client.query("COMMIT");
    res.status(201).json(rows[0]);
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    sendError(err, res, next);
  } finally { client.release(); }
});

router.patch("/warehouses/:id", async (req: any, res, next) => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const current = await warehouseById(req.params.id, client, true);
    ensureWarehouseManageScope(req, current);
    const name = req.body?.name === undefined ? current.name : String(req.body.name || "").trim();
    if (!name) fail(400, "A raktár neve kötelező.");
    const type = req.body?.warehouse_type === undefined ? current.warehouse_type : String(req.body.warehouse_type);
    if (!["retail","consumable","mixed","transit"].includes(type)) fail(400, "Érvénytelen raktártípus.");
    const sale = req.body?.is_default_sale === undefined ? Boolean(current.is_default_sale) : Boolean(req.body.is_default_sale);
    const consumption = req.body?.is_default_consumption === undefined ? Boolean(current.is_default_consumption) : Boolean(req.body.is_default_consumption);
    await updateWarehouseDefaults(client, current, sale, consumption);
    const { rows } = await client.query(`UPDATE inventory_warehouses SET name=$2,code=$3,warehouse_type=$4,comment=$5,is_default_sale=$6,is_default_consumption=$7,active=$8,sort_order=$9,updated_by=$10,updated_at=now() WHERE id=$1 RETURNING *`, [
      current.id, name, req.body?.code === undefined ? current.code : String(req.body.code || "").trim() || null, type,
      req.body?.comment === undefined ? current.comment : String(req.body.comment || "").trim() || null,
      sale, consumption, req.body?.active === undefined ? current.active : Boolean(req.body.active),
      req.body?.sort_order === undefined ? current.sort_order : Number(req.body.sort_order || 100), actor(req),
    ]);
    await client.query("COMMIT");
    res.json(rows[0]);
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    sendError(err, res, next);
  } finally { client.release(); }
});

router.get("/settings", async (req: any, res, next) => {
  try {
    let locationId = String(req.query.location_id || "").trim() || null;
    if (!isGlobal(req)) locationId = ownLocation(req);
    res.json(await inventorySetting(locationId));
  } catch (err) { sendError(err, res, next); }
});

router.patch("/settings", async (req: any, res, next) => {
  try {
    if (!canConfigure(req)) fail(403, "Nincs jogosultsága készletbeállítás módosításához.");
    let locationId = String(req.body?.location_id || "").trim() || null;
    if (!isGlobal(req)) locationId = ownLocation(req);
    const method = String(req.body?.cost_method || "weighted_average");
    const missingMode = String(req.body?.stocktake_missing_mode || "system");
    const barcodeIncrement = num(req.body?.barcode_increment ?? 1);
    if (!["weighted_average","latest_receipt","product_cost"].includes(method)) fail(400, "Érvénytelen költségszámítási mód.");
    if (!["system","zero"].includes(missingMode)) fail(400, "Érvénytelen leltári hiányzó-tétel kezelés.");
    if (barcodeIncrement === null || barcodeIncrement <= 0) fail(400, "A vonalkódos növekménynek pozitívnak kell lennie.");
    const { rows } = await db.query(`INSERT INTO inventory_settings(location_key,cost_method,prevent_negative_stock,stocktake_missing_mode,barcode_increment,updated_by,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,now()) ON CONFLICT(location_key) DO UPDATE SET cost_method=EXCLUDED.cost_method,prevent_negative_stock=EXCLUDED.prevent_negative_stock,stocktake_missing_mode=EXCLUDED.stocktake_missing_mode,barcode_increment=EXCLUDED.barcode_increment,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`, [locationKey(locationId), method, req.body?.prevent_negative_stock !== false, missingMode, barcodeIncrement, actor(req)]);
    res.json(rows[0]);
  } catch (err) { sendError(err, res, next); }
});

router.get("/units", async (_req, res, next) => {
  try { const { rows } = await db.query(`SELECT * FROM inventory_units WHERE active=true ORDER BY sort_order,name`); res.json(rows); }
  catch (err) { next(err); }
});

router.post("/units", async (req: any, res, next) => {
  try {
    if (!canMasterData(req)) fail(403, "Csak menedzsment hozhat létre mértékegységet.");
    const code = String(req.body?.code || "").trim().toLowerCase();
    const name = String(req.body?.name || "").trim();
    if (!code || !name) fail(400, "A kód és a megnevezés kötelező.");
    const { rows } = await db.query(`INSERT INTO inventory_units(code,name,precision_digits,sort_order) VALUES($1,$2,$3,$4) RETURNING *`, [code, name, Math.max(0, Math.min(6, Number(req.body?.precision_digits ?? 3))), Number(req.body?.sort_order || 100)]);
    res.status(201).json(rows[0]);
  } catch (err) { sendError(err, res, next); }
});

router.patch("/units/:id", async (req: any, res, next) => {
  try {
    if (!canMasterData(req)) fail(403, "Csak menedzsment módosíthat mértékegységet.");
    const { rows } = await db.query(`UPDATE inventory_units SET code=COALESCE(NULLIF($2,''),code),name=COALESCE(NULLIF($3,''),name),precision_digits=COALESCE($4,precision_digits),active=COALESCE($5,active),sort_order=COALESCE($6,sort_order),updated_at=now() WHERE id=$1 RETURNING *`, [req.params.id, String(req.body?.code || "").trim().toLowerCase(), String(req.body?.name || "").trim(), req.body?.precision_digits == null ? null : Number(req.body.precision_digits), req.body?.active == null ? null : Boolean(req.body.active), req.body?.sort_order == null ? null : Number(req.body.sort_order)]);
    if (!rows[0]) fail(404, "A mértékegység nem található.");
    res.json(rows[0]);
  } catch (err) { sendError(err, res, next); }
});

router.get("/balances", async (req: any, res, next) => {
  try {
    const params: any[] = [];
    const filters = ["w.active=true"];
    if (!isGlobal(req)) {
      const own = ownLocation(req); if (!own) return res.json([]);
      params.push(own); filters.push(`w.location_id=$${params.length}::text`);
    } else if (req.query.location_id !== undefined) {
      const l = String(req.query.location_id || "").trim() || null;
      if (l === null) filters.push("w.location_id IS NULL"); else { params.push(l); filters.push(`w.location_id=$${params.length}::text`); }
    }
    if (req.query.warehouse_id) { params.push(String(req.query.warehouse_id)); filters.push(`w.id=$${params.length}`); }
    if (req.query.category_id) { params.push(String(req.query.category_id)); filters.push(`p.product_category_id::text=$${params.length}::text`); }
    if (String(req.query.critical_only || "") === "1") filters.push("b.min_quantity>0 AND b.quantity<=b.min_quantity");
    const search = String(req.query.q || "").trim();
    if (search) { params.push(`%${search}%`); filters.push(`(p.name ILIKE $${params.length} OR COALESCE(p.internal_code,'') ILIKE $${params.length} OR COALESCE(p.barcode,'') ILIKE $${params.length} OR COALESCE(p.brand,'') ILIKE $${params.length})`); }
    const { rows } = await db.query(`SELECT b.id,b.warehouse_id,w.name AS warehouse_name,w.location_id,l.name AS location_name,w.warehouse_type,
      b.product_id::text,p.name AS product_name,p.internal_code,p.barcode,p.brand,p.product_group_id::text,p.product_category_id::text,
      g.name AS product_group_name,c.name AS product_category_name,b.quantity::numeric,b.min_quantity::numeric,b.optimal_quantity::numeric,b.unit_cost::numeric,
      (b.quantity*b.unit_cost)::numeric AS stock_value,
      CASE WHEN b.quantity<=0 THEN 'out' WHEN b.min_quantity>0 AND b.quantity<=b.min_quantity THEN 'low' ELSE 'ok' END AS stock_status,b.updated_at
      FROM inventory_warehouse_balances b JOIN inventory_warehouses w ON w.id=b.warehouse_id
      JOIN products p ON p.id=b.product_id LEFT JOIN locations l ON l.id::text=w.location_id
      LEFT JOIN product_groups g ON g.id=p.product_group_id LEFT JOIN product_categories c ON c.id=p.product_category_id
      WHERE ${filters.join(" AND ")} ORDER BY COALESCE(l.name,'Központ'),w.sort_order,COALESCE(g.sort_order,999),COALESCE(c.sort_order,999),p.name`, params);
    res.json(rows);
  } catch (err) { sendError(err, res, next); }
});

router.patch("/balances/:id/settings", async (req: any, res, next) => {
  const client = await db.connect();
  try {
    ensureOperator(req);
    const minQty = num(req.body?.min_quantity);
    const optimalQty = num(req.body?.optimal_quantity);
    if (minQty === null || minQty < 0 || optimalQty === null || optimalQty < 0) fail(400, "A kritikus és optimális készletszint nem lehet negatív.");
    if (optimalQty > 0 && optimalQty < minQty) fail(400, "Az optimális készletszint nem lehet kisebb a kritikusszintnél.");
    await client.query("BEGIN");
    const current = await client.query(`SELECT b.*,w.location_id FROM inventory_warehouse_balances b JOIN inventory_warehouses w ON w.id=b.warehouse_id WHERE b.id=$1 FOR UPDATE`, [req.params.id]);
    if (!current.rows[0]) fail(404, "A készletegyenleg nem található.");
    ensureWarehouseScope(req, current.rows[0]);
    const { rows } = await client.query(`UPDATE inventory_warehouse_balances SET min_quantity=$2,optimal_quantity=$3,updated_at=now() WHERE id=$1 RETURNING *`, [req.params.id, minQty, optimalQty]);
    await syncLegacyAggregate(client, String(current.rows[0].product_id), current.rows[0].location_id == null ? null : String(current.rows[0].location_id));
    await client.query("COMMIT");
    res.json(rows[0]);
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    sendError(err, res, next);
  } finally { client.release(); }
});

router.get("/summary", async (req: any, res, next) => {
  try {
    const params: any[] = [];
    let scope = "w.active=true";
    if (!isGlobal(req)) {
      const own = ownLocation(req); if (!own) return res.json({ warehouse_count:0,product_count:0,stock_value:0,low_count:0,out_count:0,open_stocktakes:0,pending_transfers:0 });
      params.push(own); scope += ` AND w.location_id=$${params.length}::text`;
    } else if (req.query.location_id !== undefined) {
      const l = String(req.query.location_id || "").trim() || null;
      if (l === null) scope += " AND w.location_id IS NULL"; else { params.push(l); scope += ` AND w.location_id=$${params.length}::text`; }
    }
    const { rows } = await db.query(`SELECT
      COUNT(DISTINCT w.id)::int AS warehouse_count,COUNT(DISTINCT b.product_id)::int AS product_count,
      COALESCE(SUM(b.quantity*b.unit_cost),0)::numeric AS stock_value,
      COUNT(*) FILTER(WHERE b.quantity>0 AND b.min_quantity>0 AND b.quantity<=b.min_quantity)::int AS low_count,
      COUNT(*) FILTER(WHERE b.quantity<=0)::int AS out_count,
      (SELECT COUNT(*)::int FROM inventory_stocktakes s JOIN inventory_warehouses sw ON sw.id=s.warehouse_id WHERE ${scope.replaceAll("w.","sw.")} AND s.status IN('draft','submitted')) AS open_stocktakes,
      (SELECT COUNT(*)::int FROM inventory_transfers t JOIN inventory_warehouses tw ON tw.id=t.source_warehouse_id WHERE ${scope.replaceAll("w.","tw.")} AND t.status IN('pending','in_transit')) AS pending_transfers
      FROM inventory_warehouses w LEFT JOIN inventory_warehouse_balances b ON b.warehouse_id=w.id WHERE ${scope}`, params);
    res.json(rows[0]);
  } catch (err) { sendError(err, res, next); }
});

router.get("/operations", async (req: any, res, next) => {
  try {
    const params: any[] = [];
    const filters = ["m.warehouse_id IS NOT NULL"];
    if (!isGlobal(req)) {
      const own = ownLocation(req); if (!own) return res.json([]);
      params.push(own); filters.push(`w.location_id=$${params.length}::text`);
    } else if (req.query.location_id !== undefined) {
      const locationId = String(req.query.location_id || "").trim() || null;
      if (locationId === null) filters.push("w.location_id IS NULL");
      else { params.push(locationId); filters.push(`w.location_id=$${params.length}::text`); }
    }
    if (req.query.warehouse_id) { params.push(String(req.query.warehouse_id)); filters.push(`m.warehouse_id=$${params.length}`); }
    if (req.query.type) { params.push(String(req.query.type)); filters.push(`m.movement_type=$${params.length}`); }
    if (req.query.product_id) { params.push(String(req.query.product_id)); filters.push(`m.product_id::text=$${params.length}::text`); }
    if (req.query.from) { params.push(String(req.query.from)); filters.push(`m.created_at>=$${params.length}::date`); }
    if (req.query.to) { params.push(String(req.query.to)); filters.push(`m.created_at<$${params.length}::date+interval '1 day'`); }
    const limit = Math.min(Math.max(Number(req.query.limit || 300), 1), 1000);
    params.push(limit);
    const { rows } = await db.query(`SELECT m.id,m.operation_group_id::text,m.document_number,m.movement_type,m.quantity::numeric,m.balance_after::numeric,m.unit_cost::numeric,m.stock_value_after::numeric,
      m.note,m.counterparty_name,m.supplier_id,m.created_by,m.created_at,m.product_id::text,p.name AS product_name,p.internal_code,p.barcode,
      m.warehouse_id,w.name AS warehouse_name,w.location_id,l.name AS location_name,m.destination_warehouse_id,dw.name AS destination_warehouse_name
      FROM inventory_movements m JOIN products p ON p.id=m.product_id
      LEFT JOIN inventory_warehouses w ON w.id=m.warehouse_id LEFT JOIN inventory_warehouses dw ON dw.id=m.destination_warehouse_id LEFT JOIN locations l ON l.id::text=w.location_id
      WHERE ${filters.join(" AND ")} ORDER BY m.created_at DESC,m.id DESC LIMIT $${params.length}`, params);
    res.json(rows);
  } catch (err) { sendError(err, res, next); }
});

router.post("/operations", async (req: any, res, next) => {
  const client = await db.connect();
  try {
    ensureOperator(req);
    const warehouse = await warehouseById(req.body?.warehouse_id, client);
    ensureWarehouseScope(req, warehouse);
    if (!warehouse.active) fail(409, "Inaktív raktárra nem rögzíthető művelet.");
    const operationType = String(req.body?.operation_type || "").trim();
    if (!["receipt","sale","writeoff","adjustment"].includes(operationType)) fail(400, "Érvénytelen készletművelet-típus.");
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) fail(400, "Legalább egy terméktétel szükséges.");
    const settings = await inventorySetting(warehouse.location_id == null ? null : String(warehouse.location_id), client);
    const group = randomUUID();
    const createdBy = actor(req);
    const supplierId = req.body?.supplier_id == null || req.body.supplier_id === "" ? null : String(req.body.supplier_id);
    const documentNumber = String(req.body?.document_number || "").trim() || null;
    const counterparty = String(req.body?.counterparty_name || "").trim() || null;
    const note = String(req.body?.note || "").trim() || null;
    await client.query("BEGIN");
    const result: any[] = [];
    for (const raw of items) {
      const productId = String(raw?.product_id || "").trim();
      const requested = num(raw?.quantity);
      if (!productId || requested === null || Math.abs(requested) < EPS) fail(400, "Érvénytelen terméktétel.");
      const product = await client.query(`SELECT id,name FROM products WHERE id=$1::uuid`, [productId]);
      if (!product.rows[0]) fail(404, "A termék nem található.");
      const bal = await balanceForUpdate(client, warehouse.id, productId);
      const currentQty = Number(bal.quantity || 0);
      const currentCost = Number(bal.unit_cost || 0);
      let delta = operationType === "receipt" ? Math.abs(requested) : operationType === "sale" || operationType === "writeoff" ? -Math.abs(requested) : requested;
      const after = currentQty + delta;
      if (settings.prevent_negative_stock && after < -EPS) fail(409, `${product.rows[0].name}: nincs elegendő készlet. Elérhető ${currentQty}, igényelt ${Math.abs(delta)}.`, "negative_stock_blocked");
      let newCost = currentCost;
      const incomingCost = raw?.unit_cost == null || raw.unit_cost === "" ? null : num(raw.unit_cost);
      if (operationType === "receipt" && delta > 0) {
        const receiptCost = incomingCost == null ? currentCost : money(incomingCost);
        if (settings.cost_method === "latest_receipt") newCost = receiptCost;
        else if (settings.cost_method === "product_cost") newCost = money(await productCost(client, productId));
        else newCost = after > EPS ? money((Math.max(0,currentQty)*currentCost + delta*receiptCost) / Math.max(after,EPS)) : receiptCost;
      }
      await client.query(`UPDATE inventory_warehouse_balances SET quantity=$2,unit_cost=$3,updated_at=now() WHERE id=$1`, [bal.id, after, newCost]);
      await addMovement(client, { productId, warehouse, movementType: operationType, quantity: delta, balanceAfter: after, unitCost: newCost, note, createdBy, operationGroupId: group, supplierId, documentNumber, counterpartyName: counterparty });
      await syncLegacyAggregate(client, productId, warehouse.location_id == null ? null : String(warehouse.location_id));
      result.push({ product_id: productId, product_name: product.rows[0].name, quantity: delta, balance_after: after, unit_cost: newCost });
    }
    await client.query("COMMIT");
    res.status(201).json({ ok: true, operation_group_id: group, operation_type: operationType, items: result });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    sendError(err, res, next);
  } finally { client.release(); }
});

router.get("/barcode/:barcode", async (req: any, res, next) => {
  try {
    const barcode = decodeURIComponent(String(req.params.barcode || "")).trim();
    const { rows } = await db.query(`SELECT p.id::text,p.name,p.internal_code,p.barcode,p.brand,p.sale_unit,p.usage_unit,p.product_category_id::text,c.name AS product_category_name
      FROM products p LEFT JOIN product_categories c ON c.id=p.product_category_id WHERE p.barcode=$1 OR p.internal_code=$1 LIMIT 10`, [barcode]);
    res.json(rows);
  } catch (err) { next(err); }
});

router.get("/stocktakes", async (req: any, res, next) => {
  try {
    const params: any[] = [];
    const filters: string[] = [];
    if (!isGlobal(req)) {
      const own = ownLocation(req); if (!own) return res.json([]);
      params.push(own); filters.push(`w.location_id=$${params.length}::text`);
    } else if (req.query.location_id !== undefined) {
      const locationId = String(req.query.location_id || "").trim() || null;
      if (locationId === null) filters.push("w.location_id IS NULL");
      else { params.push(locationId); filters.push(`w.location_id=$${params.length}::text`); }
    }
    if (req.query.warehouse_id) { params.push(String(req.query.warehouse_id)); filters.push(`s.warehouse_id=$${params.length}`); }
    const { rows } = await db.query(`SELECT s.*,w.name AS warehouse_name,w.location_id,l.name AS location_name,c.name AS category_name,
      COUNT(i.id)::int AS item_count,COUNT(i.id) FILTER(WHERE i.counted_quantity IS NOT NULL)::int AS counted_count,
      COUNT(i.id) FILTER(WHERE i.counted_quantity IS NOT NULL AND ABS(i.counted_quantity-i.expected_quantity)>${EPS})::int AS difference_count,
      COALESCE(SUM((COALESCE(i.counted_quantity,i.expected_quantity)-i.expected_quantity)*i.unit_cost),0)::numeric AS difference_value
      FROM inventory_stocktakes s JOIN inventory_warehouses w ON w.id=s.warehouse_id LEFT JOIN locations l ON l.id::text=w.location_id
      LEFT JOIN product_categories c ON c.id=s.product_category_id LEFT JOIN inventory_stocktake_items i ON i.stocktake_id=s.id
      ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""} GROUP BY s.id,w.id,l.name,c.name ORDER BY s.created_at DESC LIMIT 100`, params);
    res.json(rows);
  } catch (err) { sendError(err, res, next); }
});

router.post("/stocktakes", async (req: any, res, next) => {
  const client = await db.connect();
  try {
    ensureOperator(req);
    const warehouse = await warehouseById(req.body?.warehouse_id, client);
    ensureWarehouseScope(req, warehouse);
    const categoryId = String(req.body?.product_category_id || "").trim() || null;
    const note = String(req.body?.note || "").trim() || null;
    await client.query("BEGIN");
    const open = await client.query(`SELECT id FROM inventory_stocktakes WHERE warehouse_id=$1 AND status IN('draft','submitted') LIMIT 1`, [warehouse.id]);
    if (open.rows[0]) fail(409, `Ebben a raktárban már van nyitott leltár (#${open.rows[0].id}).`, "stocktake_already_open");
    const header = await client.query(`INSERT INTO inventory_stocktakes(warehouse_id,product_category_id,note,created_by) VALUES($1,$2::uuid,$3,$4) RETURNING *`, [warehouse.id, categoryId, note, actor(req)]);
    const id = header.rows[0].id;
    await client.query(`INSERT INTO inventory_stocktake_items(stocktake_id,product_id,product_name_snapshot,barcode_snapshot,expected_quantity,unit_cost)
      SELECT $1,b.product_id,p.name,p.barcode,b.quantity,b.unit_cost FROM inventory_warehouse_balances b JOIN products p ON p.id=b.product_id
      WHERE b.warehouse_id=$2 AND ($3::uuid IS NULL OR p.product_category_id=$3::uuid) ORDER BY p.name`, [id, warehouse.id, categoryId]);
    const count = await client.query(`SELECT COUNT(*)::int AS n FROM inventory_stocktake_items WHERE stocktake_id=$1`, [id]);
    if (!Number(count.rows[0]?.n || 0)) fail(409, "A kiválasztott raktárban nincs leltározható termék.", "stocktake_empty");
    await client.query("COMMIT");
    res.status(201).json({ ...header.rows[0], item_count: count.rows[0].n });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    sendError(err, res, next);
  } finally { client.release(); }
});

router.get("/stocktakes/:id", async (req: any, res, next) => {
  try {
    const head = await db.query(`SELECT s.*,w.name AS warehouse_name,w.location_id,l.name AS location_name,c.name AS category_name FROM inventory_stocktakes s JOIN inventory_warehouses w ON w.id=s.warehouse_id LEFT JOIN locations l ON l.id::text=w.location_id LEFT JOIN product_categories c ON c.id=s.product_category_id WHERE s.id=$1`, [req.params.id]);
    if (!head.rows[0]) fail(404, "A leltár nem található.");
    ensureWarehouseScope(req, head.rows[0]);
    const items = await db.query(`SELECT i.*,p.internal_code,p.brand,g.name AS product_group_name,c.name AS product_category_name,
      (COALESCE(i.counted_quantity,i.expected_quantity)-i.expected_quantity)::numeric AS difference,
      ((COALESCE(i.counted_quantity,i.expected_quantity)-i.expected_quantity)*i.unit_cost)::numeric AS difference_value
      FROM inventory_stocktake_items i JOIN products p ON p.id=i.product_id LEFT JOIN product_groups g ON g.id=p.product_group_id LEFT JOIN product_categories c ON c.id=p.product_category_id
      WHERE i.stocktake_id=$1 ORDER BY COALESCE(g.sort_order,999),COALESCE(c.sort_order,999),p.name`, [req.params.id]);
    res.json({ ...head.rows[0], items: items.rows });
  } catch (err) { sendError(err, res, next); }
});

router.patch("/stocktakes/:id/items", async (req: any, res, next) => {
  const client = await db.connect();
  try {
    ensureOperator(req);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) fail(400, "Nincs menthető leltári tétel.");
    await client.query("BEGIN");
    const head = await client.query(`SELECT s.*,w.location_id FROM inventory_stocktakes s JOIN inventory_warehouses w ON w.id=s.warehouse_id WHERE s.id=$1 FOR UPDATE OF s`, [req.params.id]);
    if (!head.rows[0]) fail(404, "A leltár nem található.");
    ensureWarehouseScope(req, head.rows[0]);
    if (head.rows[0].status !== "draft") fail(409, "Csak piszkozat leltár módosítható.");
    for (const raw of items) {
      const q = num(raw?.counted_quantity);
      if (q === null || q < 0) fail(400, "A megszámolt mennyiség nem lehet negatív.");
      const updated = await client.query(`UPDATE inventory_stocktake_items SET counted_quantity=$3,updated_at=now() WHERE id=$1 AND stocktake_id=$2`, [String(raw?.id || ""), req.params.id, q]);
      if (!updated.rowCount) fail(404, "Leltári tétel nem található.");
    }
    await client.query(`UPDATE inventory_stocktakes SET updated_at=now() WHERE id=$1`, [req.params.id]);
    await client.query("COMMIT");
    res.json({ ok: true, updated: items.length });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    sendError(err, res, next);
  } finally { client.release(); }
});

router.post("/stocktakes/:id/scan", async (req: any, res, next) => {
  const client = await db.connect();
  try {
    ensureOperator(req);
    const barcode = String(req.body?.barcode || "").trim();
    if (!barcode) fail(400, "A vonalkód kötelező.");
    await client.query("BEGIN");
    const head = await client.query(`SELECT s.*,w.location_id FROM inventory_stocktakes s JOIN inventory_warehouses w ON w.id=s.warehouse_id WHERE s.id=$1 FOR UPDATE OF s`, [req.params.id]);
    if (!head.rows[0]) fail(404, "A leltár nem található.");
    ensureWarehouseScope(req, head.rows[0]);
    if (head.rows[0].status !== "draft") fail(409, "Csak piszkozat leltárhoz lehet vonalkódot olvasni.");
    const setting = await inventorySetting(head.rows[0].location_id == null ? null : String(head.rows[0].location_id), client);
    const { rows } = await client.query(`UPDATE inventory_stocktake_items i SET counted_quantity=COALESCE(i.counted_quantity,0)+$3,updated_at=now()
      FROM products p WHERE i.stocktake_id=$1 AND i.product_id=p.id AND (p.barcode=$2 OR p.internal_code=$2)
      RETURNING i.*,p.name AS product_name,p.internal_code,p.barcode`, [req.params.id, barcode, Number(setting.barcode_increment || 1)]);
    if (!rows[0]) fail(404, "A vonalkódhoz tartozó termék nincs ebben a leltárban.", "stocktake_barcode_not_found");
    await client.query("COMMIT");
    res.json(rows[0]);
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    sendError(err, res, next);
  } finally { client.release(); }
});

router.post("/stocktakes/:id/submit", async (req: any, res, next) => {
  const client = await db.connect();
  try {
    ensureOperator(req);
    await client.query("BEGIN");
    const head = await client.query(`SELECT s.*,w.location_id FROM inventory_stocktakes s JOIN inventory_warehouses w ON w.id=s.warehouse_id WHERE s.id=$1 FOR UPDATE OF s`, [req.params.id]);
    if (!head.rows[0]) fail(404, "A leltár nem található.");
    ensureWarehouseScope(req, head.rows[0]);
    if (head.rows[0].status !== "draft") fail(409, "Csak piszkozat leltár küldhető jóváhagyásra.");
    const setting = await inventorySetting(head.rows[0].location_id == null ? null : String(head.rows[0].location_id), client);
    if (setting.stocktake_missing_mode === "zero") await client.query(`UPDATE inventory_stocktake_items SET counted_quantity=0,updated_at=now() WHERE stocktake_id=$1 AND counted_quantity IS NULL`, [req.params.id]);
    else await client.query(`UPDATE inventory_stocktake_items SET counted_quantity=expected_quantity,updated_at=now() WHERE stocktake_id=$1 AND counted_quantity IS NULL`, [req.params.id]);
    const { rows } = await client.query(`UPDATE inventory_stocktakes SET status='submitted',submitted_by=$2,submitted_at=now(),updated_at=now() WHERE id=$1 RETURNING *`, [req.params.id, actor(req)]);
    await client.query("COMMIT");
    res.json(rows[0]);
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    sendError(err, res, next);
  } finally { client.release(); }
});

router.post("/stocktakes/:id/approve", async (req: any, res, next) => {
  const client = await db.connect();
  try {
    if (!canApprove(req)) fail(403, "Nincs jogosultsága leltár jóváhagyásához.");
    await client.query("BEGIN");
    const head = await client.query(`SELECT s.*,w.location_id,w.name AS warehouse_name FROM inventory_stocktakes s JOIN inventory_warehouses w ON w.id=s.warehouse_id WHERE s.id=$1 FOR UPDATE OF s`, [req.params.id]);
    const stocktake = head.rows[0];
    if (!stocktake) fail(404, "A leltár nem található.");
    ensureWarehouseScope(req, stocktake);
    if (stocktake.status !== "submitted") fail(409, "Csak jóváhagyásra beküldött leltár zárható le.");
    const items = await client.query(`SELECT i.*,p.name AS product_name FROM inventory_stocktake_items i JOIN products p ON p.id=i.product_id WHERE i.stocktake_id=$1 ORDER BY i.id FOR UPDATE OF i`, [req.params.id]);
    const group = randomUUID();
    for (const item of items.rows) {
      const bal = await balanceForUpdate(client, stocktake.warehouse_id, String(item.product_id));
      const current = Number(bal.quantity || 0), expected = Number(item.expected_quantity || 0), counted = Number(item.counted_quantity || 0);
      if (Math.abs(current - expected) > EPS) fail(409, `${item.product_name}: a készlet a leltár indítása óta megváltozott. Új leltár szükséges.`, "stocktake_stale");
      const diff = counted - current;
      if (Math.abs(diff) > EPS) {
        await client.query(`UPDATE inventory_warehouse_balances SET quantity=$2,updated_at=now() WHERE id=$1`, [bal.id, counted]);
        await addMovement(client, { productId: String(item.product_id), warehouse: { id: stocktake.warehouse_id, location_id: stocktake.location_id }, movementType: "stocktake_adjustment", quantity: diff, balanceAfter: counted, unitCost: Number(bal.unit_cost || item.unit_cost || 0), note: `Leltár #${stocktake.id} jóváhagyott eltérés`, createdBy: actor(req), operationGroupId: group, documentNumber: `ST-${stocktake.id}` });
        await syncLegacyAggregate(client, String(item.product_id), stocktake.location_id == null ? null : String(stocktake.location_id));
      }
    }
    const { rows } = await client.query(`UPDATE inventory_stocktakes SET status='approved',approved_by=$2,approved_at=now(),updated_at=now() WHERE id=$1 RETURNING *`, [req.params.id, actor(req)]);
    await client.query("COMMIT");
    res.json(rows[0]);
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    sendError(err, res, next);
  } finally { client.release(); }
});

router.post("/stocktakes/:id/cancel", async (req: any, res, next) => {
  try {
    ensureOperator(req);
    const head = await db.query(`SELECT s.*,w.location_id FROM inventory_stocktakes s JOIN inventory_warehouses w ON w.id=s.warehouse_id WHERE s.id=$1`, [req.params.id]);
    if (!head.rows[0]) fail(404, "A leltár nem található.");
    ensureWarehouseScope(req, head.rows[0]);
    if (!["draft","submitted"].includes(head.rows[0].status)) fail(409, "A lezárt leltár nem vonható vissza.");
    const { rows } = await db.query(`UPDATE inventory_stocktakes SET status='cancelled',updated_at=now() WHERE id=$1 RETURNING *`, [req.params.id]);
    res.json(rows[0]);
  } catch (err) { sendError(err, res, next); }
});

router.get("/transfers", async (req: any, res, next) => {
  try {
    const params: any[] = [];
    const filters: string[] = [];
    if (!isGlobal(req)) {
      const own = ownLocation(req); if (!own) return res.json([]);
      params.push(own); filters.push(`(sw.location_id=$${params.length}::text OR dw.location_id=$${params.length}::text)`);
    } else if (req.query.location_id !== undefined) {
      const locationId = String(req.query.location_id || "").trim() || null;
      if (locationId === null) filters.push("(sw.location_id IS NULL OR dw.location_id IS NULL)");
      else { params.push(locationId); filters.push(`(sw.location_id=$${params.length}::text OR dw.location_id=$${params.length}::text)`); }
    }
    const { rows } = await db.query(`SELECT t.*,sw.name AS source_warehouse_name,sw.location_id AS source_location_id,sl.name AS source_location_name,
      dw.name AS destination_warehouse_name,dw.location_id AS destination_location_id,dl.name AS destination_location_name,
      COUNT(i.id)::int AS item_count,COALESCE(SUM(i.quantity),0)::numeric AS total_quantity
      FROM inventory_transfers t JOIN inventory_warehouses sw ON sw.id=t.source_warehouse_id JOIN inventory_warehouses dw ON dw.id=t.destination_warehouse_id
      LEFT JOIN locations sl ON sl.id::text=sw.location_id LEFT JOIN locations dl ON dl.id::text=dw.location_id LEFT JOIN inventory_transfer_items i ON i.transfer_id=t.id
      ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""} GROUP BY t.id,sw.id,dw.id,sl.name,dl.name ORDER BY t.created_at DESC LIMIT 100`, params);
    res.json(rows);
  } catch (err) { sendError(err, res, next); }
});

router.post("/transfers", async (req: any, res, next) => {
  const client = await db.connect();
  try {
    ensureOperator(req);
    const source = await warehouseById(req.body?.source_warehouse_id, client);
    const destination = await warehouseById(req.body?.destination_warehouse_id, client);
    ensureWarehouseScope(req, source);
    if (String(source.id) === String(destination.id)) fail(400, "A forrás- és célraktár nem lehet azonos.");
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) fail(400, "Legalább egy áthelyezési tétel szükséges.");
    await client.query("BEGIN");
    const doc = `TR-${new Date().getFullYear()}-${Date.now().toString().slice(-8)}`;
    const head = await client.query(`INSERT INTO inventory_transfers(source_warehouse_id,destination_warehouse_id,status,document_number,note,created_by) VALUES($1,$2,'pending',$3,$4,$5) RETURNING *`, [source.id, destination.id, doc, String(req.body?.note || "").trim() || null, actor(req)]);
    for (const raw of items) {
      const productId = String(raw?.product_id || "").trim();
      const qty = num(raw?.quantity);
      if (!productId || qty === null || qty <= 0) fail(400, "Az áthelyezési mennyiségnek pozitívnak kell lennie.");
      const product = await client.query(`SELECT id,name FROM products WHERE id=$1::uuid`, [productId]);
      if (!product.rows[0]) fail(404, "Áthelyezendő termék nem található.");
      const bal = await balanceForUpdate(client, source.id, productId);
      await client.query(`INSERT INTO inventory_transfer_items(transfer_id,product_id,product_name_snapshot,quantity,unit_cost) VALUES($1,$2::uuid,$3,$4,$5)`, [head.rows[0].id, productId, product.rows[0].name, qty, Number(bal.unit_cost || 0)]);
    }
    await client.query("COMMIT");
    res.status(201).json(head.rows[0]);
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    sendError(err, res, next);
  } finally { client.release(); }
});

router.get("/transfers/:id", async (req: any, res, next) => {
  try {
    const head = await db.query(`SELECT t.*,sw.name AS source_warehouse_name,sw.location_id AS source_location_id,sl.name AS source_location_name,
      dw.name AS destination_warehouse_name,dw.location_id AS destination_location_id,dl.name AS destination_location_name
      FROM inventory_transfers t JOIN inventory_warehouses sw ON sw.id=t.source_warehouse_id JOIN inventory_warehouses dw ON dw.id=t.destination_warehouse_id
      LEFT JOIN locations sl ON sl.id::text=sw.location_id LEFT JOIN locations dl ON dl.id::text=dw.location_id WHERE t.id=$1`, [req.params.id]);
    if (!head.rows[0]) fail(404, "Az áthelyezés nem található.");
    if (!isGlobal(req)) {
      const own = ownLocation(req);
      if (!own || (String(head.rows[0].source_location_id || "") !== own && String(head.rows[0].destination_location_id || "") !== own)) fail(403, "Ehhez az áthelyezéshez nincs jogosultsága.");
    }
    const items = await db.query(`SELECT i.*,p.internal_code,p.barcode,p.brand FROM inventory_transfer_items i JOIN products p ON p.id=i.product_id WHERE i.transfer_id=$1 ORDER BY p.name`, [req.params.id]);
    res.json({ ...head.rows[0], items: items.rows });
  } catch (err) { sendError(err, res, next); }
});

router.post("/transfers/:id/dispatch", async (req: any, res, next) => {
  const client = await db.connect();
  try {
    ensureOperator(req);
    await client.query("BEGIN");
    const head = await client.query(`SELECT t.*,sw.location_id AS source_location_id,sw.name AS source_warehouse_name FROM inventory_transfers t JOIN inventory_warehouses sw ON sw.id=t.source_warehouse_id WHERE t.id=$1 FOR UPDATE OF t`, [req.params.id]);
    const transfer = head.rows[0];
    if (!transfer) fail(404, "Az áthelyezés nem található.");
    ensureWarehouseScope(req, { location_id: transfer.source_location_id });
    if (transfer.status !== "pending") fail(409, "Csak függő áthelyezés indítható el.");
    const source = await warehouseById(transfer.source_warehouse_id, client);
    const settings = await inventorySetting(source.location_id == null ? null : String(source.location_id), client);
    const items = await client.query(`SELECT * FROM inventory_transfer_items WHERE transfer_id=$1 ORDER BY id FOR UPDATE`, [req.params.id]);
    const group = randomUUID();
    for (const item of items.rows) {
      const bal = await balanceForUpdate(client, source.id, String(item.product_id));
      const current = Number(bal.quantity || 0), qty = Number(item.quantity || 0), after = current - qty;
      if (settings.prevent_negative_stock && after < -EPS) fail(409, `${item.product_name_snapshot}: nincs elegendő készlet az áthelyezéshez.`, "transfer_insufficient_stock");
      await client.query(`UPDATE inventory_warehouse_balances SET quantity=$2,updated_at=now() WHERE id=$1`, [bal.id, after]);
      await client.query(`UPDATE inventory_transfer_items SET unit_cost=$2 WHERE id=$1`, [item.id, Number(bal.unit_cost || 0)]);
      await addMovement(client, { productId: String(item.product_id), warehouse: source, movementType: "transfer_out", quantity: -qty, balanceAfter: after, unitCost: Number(bal.unit_cost || 0), note: `Áthelyezés ${transfer.document_number}`, createdBy: actor(req), operationGroupId: group, destinationWarehouseId: transfer.destination_warehouse_id, documentNumber: transfer.document_number });
      await syncLegacyAggregate(client, String(item.product_id), source.location_id == null ? null : String(source.location_id));
    }
    const { rows } = await client.query(`UPDATE inventory_transfers SET status='in_transit',dispatched_by=$2,dispatched_at=now(),updated_at=now() WHERE id=$1 RETURNING *`, [req.params.id, actor(req)]);
    await client.query("COMMIT");
    res.json(rows[0]);
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    sendError(err, res, next);
  } finally { client.release(); }
});

router.post("/transfers/:id/receive", async (req: any, res, next) => {
  const client = await db.connect();
  try {
    ensureOperator(req);
    await client.query("BEGIN");
    const head = await client.query(`SELECT t.*,dw.location_id AS destination_location_id,dw.name AS destination_warehouse_name FROM inventory_transfers t JOIN inventory_warehouses dw ON dw.id=t.destination_warehouse_id WHERE t.id=$1 FOR UPDATE OF t`, [req.params.id]);
    const transfer = head.rows[0];
    if (!transfer) fail(404, "Az áthelyezés nem található.");
    ensureWarehouseScope(req, { location_id: transfer.destination_location_id });
    if (transfer.status !== "in_transit") fail(409, "Csak úton lévő áthelyezés vehető át.");
    const destination = await warehouseById(transfer.destination_warehouse_id, client);
    const settings = await inventorySetting(destination.location_id == null ? null : String(destination.location_id), client);
    const items = await client.query(`SELECT * FROM inventory_transfer_items WHERE transfer_id=$1 ORDER BY id FOR UPDATE`, [req.params.id]);
    const group = randomUUID();
    for (const item of items.rows) {
      const bal = await balanceForUpdate(client, destination.id, String(item.product_id));
      const current = Number(bal.quantity || 0), qty = Number(item.quantity || 0), sourceCost = Number(item.unit_cost || 0), after = current + qty;
      let newCost = Number(bal.unit_cost || 0);
      if (settings.cost_method === "latest_receipt") newCost = sourceCost;
      else if (settings.cost_method === "product_cost") newCost = money(await productCost(client, String(item.product_id)));
      else newCost = after > EPS ? money((Math.max(0,current)*newCost + qty*sourceCost) / Math.max(after,EPS)) : sourceCost;
      await client.query(`UPDATE inventory_warehouse_balances SET quantity=$2,unit_cost=$3,updated_at=now() WHERE id=$1`, [bal.id, after, newCost]);
      await addMovement(client, { productId: String(item.product_id), warehouse: destination, movementType: "transfer_in", quantity: qty, balanceAfter: after, unitCost: newCost, note: `Áthelyezés ${transfer.document_number} átvétele`, createdBy: actor(req), operationGroupId: group, destinationWarehouseId: destination.id, documentNumber: transfer.document_number });
      await syncLegacyAggregate(client, String(item.product_id), destination.location_id == null ? null : String(destination.location_id));
    }
    const { rows } = await client.query(`UPDATE inventory_transfers SET status='received',received_by=$2,received_at=now(),updated_at=now() WHERE id=$1 RETURNING *`, [req.params.id, actor(req)]);
    await client.query("COMMIT");
    res.json(rows[0]);
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    sendError(err, res, next);
  } finally { client.release(); }
});

router.post("/transfers/:id/cancel", async (req: any, res, next) => {
  try {
    ensureOperator(req);
    const head = await db.query(`SELECT t.*,w.location_id FROM inventory_transfers t JOIN inventory_warehouses w ON w.id=t.source_warehouse_id WHERE t.id=$1`, [req.params.id]);
    if (!head.rows[0]) fail(404, "Az áthelyezés nem található.");
    ensureWarehouseScope(req, head.rows[0]);
    if (head.rows[0].status !== "pending") fail(409, "Csak el nem indított áthelyezés vonható vissza.");
    const { rows } = await db.query(`UPDATE inventory_transfers SET status='cancelled',updated_at=now() WHERE id=$1 RETURNING *`, [req.params.id]);
    res.json(rows[0]);
  } catch (err) { sendError(err, res, next); }
});

router.get("/reorder-suggestions", async (req: any, res, next) => {
  try {
    const params: any[] = [];
    const filters = ["w.active=true", "b.min_quantity>0", "b.quantity<=b.min_quantity"];
    if (!isGlobal(req)) {
      const own = ownLocation(req); if (!own) return res.json([]);
      params.push(own); filters.push(`w.location_id=$${params.length}::text`);
    }
    if (req.query.warehouse_id) { params.push(String(req.query.warehouse_id)); filters.push(`w.id=$${params.length}`); }
    const { rows } = await db.query(`WITH preferred AS (
      SELECT DISTINCT ON(pst.product_id) pst.product_id,pst.supplier_id,s.name AS supplier_name,pst.unit_price,pst.minimum_order_quantity,pst.lead_time_days,pst.preferred
      FROM product_supplier_terms pst JOIN suppliers s ON s.id=pst.supplier_id AND s.active=true WHERE pst.active=true
      ORDER BY pst.product_id,pst.preferred DESC,pst.unit_price ASC,pst.lead_time_days ASC)
      SELECT b.id AS balance_id,b.product_id::text,p.name AS product_name,p.internal_code,p.brand,w.id AS warehouse_id,w.name AS warehouse_name,w.location_id,l.name AS location_name,
      b.quantity::numeric AS current_quantity,b.min_quantity::numeric,b.optimal_quantity::numeric,
      COALESCE(pr.unit_price,b.unit_cost,0)::numeric AS unit_cost,pr.supplier_id,pr.supplier_name,pr.minimum_order_quantity,pr.lead_time_days,pr.preferred,
      GREATEST(CASE WHEN b.optimal_quantity>b.min_quantity THEN b.optimal_quantity ELSE b.min_quantity*2 END-b.quantity,COALESCE(pr.minimum_order_quantity,0),0)::numeric AS suggested_quantity,
      (GREATEST(CASE WHEN b.optimal_quantity>b.min_quantity THEN b.optimal_quantity ELSE b.min_quantity*2 END-b.quantity,COALESCE(pr.minimum_order_quantity,0),0)*COALESCE(pr.unit_price,b.unit_cost,0))::numeric AS expected_cost
      FROM inventory_warehouse_balances b JOIN inventory_warehouses w ON w.id=b.warehouse_id JOIN products p ON p.id=b.product_id LEFT JOIN locations l ON l.id::text=w.location_id LEFT JOIN preferred pr ON pr.product_id=b.product_id
      WHERE ${filters.join(" AND ")} ORDER BY COALESCE(l.name,'Központ'),w.sort_order,pr.supplier_name NULLS LAST,p.name`, params);
    res.json(rows);
  } catch (err) { sendError(err, res, next); }
});

router.get("/bom", async (req: any, res, next) => {
  try {
    const serviceId = String(req.query.service_id || "").trim() || null;
    const params: any[] = [];
    let filter = "r.active=true";
    if (serviceId) { params.push(serviceId); filter += ` AND r.service_id::text=$${params.length}::text`; }
    const { rows } = await db.query(`SELECT r.id,r.service_id::text,s.name AS service_name,r.product_id::text,p.name AS product_name,p.internal_code,p.brand,r.default_quantity::numeric,r.unit,r.required,r.note,r.updated_at
      FROM service_material_requirements r JOIN services s ON s.id=r.service_id JOIN products p ON p.id=r.product_id WHERE ${filter} ORDER BY s.name,p.name`, params);
    res.json(rows);
  } catch (err) { sendError(err, res, next); }
});

router.post("/bom", async (req: any, res, next) => {
  try {
    if (!canMasterData(req)) fail(403, "Csak menedzsment módosíthat szolgáltatási anyagjegyzéket.");
    const serviceId = String(req.body?.service_id || "").trim(), productId = String(req.body?.product_id || "").trim();
    const quantity = num(req.body?.default_quantity);
    if (!serviceId || !productId || quantity === null || quantity <= 0) fail(400, "A szolgáltatás, termék és pozitív mennyiség kötelező.");
    const unit = String(req.body?.unit || "db").trim() || "db";
    const { rows } = await db.query(`INSERT INTO service_material_requirements(service_id,product_id,default_quantity,unit,required,active,note,updated_at)
      VALUES($1::uuid,$2::uuid,$3,$4,$5,true,$6,now()) ON CONFLICT(service_id,product_id) DO UPDATE SET default_quantity=EXCLUDED.default_quantity,unit=EXCLUDED.unit,required=EXCLUDED.required,active=true,note=EXCLUDED.note,updated_at=now() RETURNING *`, [serviceId, productId, quantity, unit, req.body?.required !== false, String(req.body?.note || "").trim() || null]);
    res.status(201).json(rows[0]);
  } catch (err) { sendError(err, res, next); }
});

router.patch("/bom/:id", async (req: any, res, next) => {
  try {
    if (!canMasterData(req)) fail(403, "Csak menedzsment módosíthat szolgáltatási anyagjegyzéket.");
    const quantity = req.body?.default_quantity == null ? null : num(req.body.default_quantity);
    if (quantity !== null && quantity <= 0) fail(400, "Az anyagnorma mennyiségének pozitívnak kell lennie.");
    const { rows } = await db.query(`UPDATE service_material_requirements SET default_quantity=COALESCE($2,default_quantity),unit=COALESCE(NULLIF($3,''),unit),required=COALESCE($4,required),active=COALESCE($5,active),note=CASE WHEN $6::boolean THEN $7 ELSE note END,updated_at=now() WHERE id=$1 RETURNING *`, [req.params.id, quantity, String(req.body?.unit || "").trim(), req.body?.required == null ? null : Boolean(req.body.required), req.body?.active == null ? null : Boolean(req.body.active), req.body?.note !== undefined, String(req.body?.note || "").trim() || null]);
    if (!rows[0]) fail(404, "Az anyagjegyzék-tétel nem található.");
    res.json(rows[0]);
  } catch (err) { sendError(err, res, next); }
});

router.delete("/bom/:id", async (req: any, res, next) => {
  try {
    if (!canMasterData(req)) fail(403, "Csak menedzsment törölhet szolgáltatási anyagjegyzéket.");
    const { rows } = await db.query(`UPDATE service_material_requirements SET active=false,updated_at=now() WHERE id=$1 RETURNING *`, [req.params.id]);
    if (!rows[0]) fail(404, "Az anyagjegyzék-tétel nem található.");
    res.json(rows[0]);
  } catch (err) { sendError(err, res, next); }
});

export default router;
