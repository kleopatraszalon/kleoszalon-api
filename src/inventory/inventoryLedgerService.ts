import { randomUUID } from "crypto";

const EPS = 0.0001;
const money = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

type Purpose = "sale" | "consumption";

type WarehouseSelector = {
  locationId: string | null;
  productId: string;
  purpose?: Purpose;
  requiredQuantity?: number;
  warehouseId?: string | number | null;
};

type MovementMeta = {
  workOrderId?: string | null;
  destinationWarehouseId?: string | number | null;
  supplierId?: string | number | null;
  documentNumber?: string | null;
  operationGroupId?: string | null;
  counterpartyName?: string | null;
  note?: string | null;
  createdBy: string;
};

function inventoryError(message: string, code: string, status = 409) {
  const error: any = new Error(message);
  error.status = status;
  error.publicCode = code;
  error.code = code;
  return error;
}

async function productPurpose(client: any, productId: string): Promise<Purpose> {
  const { rows } = await client.query(`
    SELECT COALESCE((to_jsonb(p)->>'is_service_material')::boolean,false) AS is_service_material
    FROM products p WHERE p.id=$1::uuid
  `, [productId]);
  if (!rows[0]) throw inventoryError("A termék nem található.", "INVENTORY_PRODUCT_NOT_FOUND", 404);
  return rows[0].is_service_material ? "consumption" : "sale";
}

export async function resolveInventoryWarehouse(client: any, selector: WarehouseSelector) {
  const locationId = selector.locationId || null;
  const requiredQuantity = Math.max(0, Number(selector.requiredQuantity || 0));
  const purpose = selector.purpose || await productPurpose(client, selector.productId);

  if (selector.warehouseId != null && String(selector.warehouseId).trim()) {
    const { rows } = await client.query(`
      SELECT w.*,COALESCE(b.quantity,0)::numeric AS product_quantity,COALESCE(b.unit_cost,0)::numeric AS product_unit_cost
      FROM inventory_warehouses w
      LEFT JOIN inventory_warehouse_balances b ON b.warehouse_id=w.id AND b.product_id=$2::uuid
      WHERE w.id=$1 AND w.active=true
    `, [selector.warehouseId, selector.productId]);
    const warehouse = rows[0];
    if (!warehouse) throw inventoryError("A kiválasztott raktár nem található vagy inaktív.", "INVENTORY_WAREHOUSE_NOT_FOUND", 404);
    const warehouseLocation = warehouse.location_id == null ? null : String(warehouse.location_id);
    if (warehouseLocation !== locationId) throw inventoryError("A kiválasztott raktár nem a rendelés vagy készletművelet telephelyéhez tartozik.", "INVENTORY_WAREHOUSE_LOCATION_MISMATCH", 400);
    if (requiredQuantity > EPS && Number(warehouse.product_quantity || 0) + EPS < requiredQuantity) {
      throw inventoryError(`A(z) ${warehouse.name} raktár készlete nem elegendő. Elérhető: ${Number(warehouse.product_quantity || 0)}, szükséges: ${requiredQuantity}.`, "INVENTORY_INSUFFICIENT_STOCK");
    }
    return warehouse;
  }

  const { rows } = await client.query(`
    SELECT w.*,COALESCE(b.quantity,0)::numeric AS product_quantity,COALESCE(b.unit_cost,0)::numeric AS product_unit_cost
    FROM inventory_warehouses w
    LEFT JOIN inventory_warehouse_balances b ON b.warehouse_id=w.id AND b.product_id=$2::uuid
    WHERE w.active=true
      AND (($1::text IS NULL AND w.location_id IS NULL) OR w.location_id=$1::text)
    ORDER BY
      CASE WHEN $4::numeric>0 AND COALESCE(b.quantity,0)>=$4::numeric THEN 0
           WHEN $4::numeric>0 THEN 1 ELSE 0 END,
      CASE WHEN $3='consumption' AND w.is_default_consumption THEN 0
           WHEN $3='sale' AND w.is_default_sale THEN 0 ELSE 1 END,
      CASE WHEN $3='consumption' AND w.warehouse_type='consumable' THEN 0
           WHEN $3='sale' AND w.warehouse_type='retail' THEN 0 ELSE 1 END,
      w.sort_order,w.id
    LIMIT 1
  `, [locationId, selector.productId, purpose, requiredQuantity]);
  const warehouse = rows[0];
  if (!warehouse) throw inventoryError("Nincs aktív raktár konfigurálva ehhez a telephelyhez.", "INVENTORY_WAREHOUSE_MISSING");
  if (requiredQuantity > EPS && Number(warehouse.product_quantity || 0) + EPS < requiredQuantity) {
    throw inventoryError(`A(z) ${warehouse.name} raktár készlete nem elegendő. Elérhető: ${Number(warehouse.product_quantity || 0)}, szükséges: ${requiredQuantity}.`, "INVENTORY_INSUFFICIENT_STOCK");
  }
  return warehouse;
}

async function balanceForUpdate(client: any, warehouseId: string | number, productId: string) {
  await client.query(`
    INSERT INTO inventory_warehouse_balances(warehouse_id,product_id,quantity,min_quantity,optimal_quantity,unit_cost)
    VALUES($1,$2::uuid,0,0,0,0)
    ON CONFLICT(warehouse_id,product_id) DO NOTHING
  `, [warehouseId, productId]);
  const { rows } = await client.query(`
    SELECT * FROM inventory_warehouse_balances
    WHERE warehouse_id=$1 AND product_id=$2::uuid
    FOR UPDATE
  `, [warehouseId, productId]);
  return rows[0];
}

async function inventorySetting(client: any, locationId: string | null) {
  const key = locationId || "__central__";
  const { rows } = await client.query(`
    SELECT COALESCE(local.cost_method,global.cost_method,'weighted_average') AS cost_method,
           COALESCE(local.prevent_negative_stock,global.prevent_negative_stock,true) AS prevent_negative_stock
    FROM (SELECT * FROM inventory_settings WHERE location_key='__global__') global
    LEFT JOIN inventory_settings local ON local.location_key=$1
  `, [key]);
  return rows[0] || { cost_method: "weighted_average", prevent_negative_stock: true };
}

async function productMasterCost(client: any, productId: string) {
  const { rows } = await client.query(`
    SELECT COALESCE(NULLIF(to_jsonb(p)->>'purchase_price_net','')::numeric,0)::numeric AS cost
    FROM products p WHERE p.id=$1::uuid
  `, [productId]);
  return Number(rows[0]?.cost || 0);
}

export async function syncLegacyInventoryAggregate(client: any, productId: string, locationId: string | null) {
  const aggregate = await client.query(`
    SELECT COALESCE(SUM(b.quantity),0)::numeric AS quantity,
           COALESCE(SUM(b.min_quantity),0)::numeric AS min_quantity,
           COALESCE(SUM(b.optimal_quantity),0)::numeric AS optimal_quantity,
           CASE WHEN SUM(CASE WHEN b.quantity>0 THEN b.quantity ELSE 0 END)>0
                THEN SUM(CASE WHEN b.quantity>0 THEN b.quantity*b.unit_cost ELSE 0 END)
                     /SUM(CASE WHEN b.quantity>0 THEN b.quantity ELSE 0 END)
                ELSE COALESCE(MAX(b.unit_cost),0) END::numeric AS unit_cost
    FROM inventory_warehouse_balances b
    JOIN inventory_warehouses w ON w.id=b.warehouse_id AND w.active=true
    WHERE b.product_id=$1::uuid
      AND (($2::text IS NULL AND w.location_id IS NULL) OR w.location_id=$2::text)
  `, [productId, locationId]);
  const a = aggregate.rows[0] || {};
  await client.query(`SELECT set_config('kleo.inventory_sync','warehouse_to_legacy',true)`);
  const existing = await client.query(`
    SELECT id FROM product_stock_balances
    WHERE product_id=$1::uuid
      AND (($2::text IS NULL AND location_id IS NULL) OR location_id::text=$2::text)
    LIMIT 1 FOR UPDATE
  `, [productId, locationId]);
  if (existing.rows[0]) {
    await client.query(`
      UPDATE product_stock_balances
      SET quantity=$2,min_quantity=$3,optimal_quantity=$4,unit_cost=$5,updated_at=now()
      WHERE id=$1
    `, [existing.rows[0].id, Number(a.quantity || 0), Number(a.min_quantity || 0), Number(a.optimal_quantity || 0), money(a.unit_cost)]);
  } else {
    await client.query(`
      INSERT INTO product_stock_balances(product_id,location_id,quantity,min_quantity,optimal_quantity,unit_cost,updated_at)
      VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,now())
    `, [productId, locationId, Number(a.quantity || 0), Number(a.min_quantity || 0), Number(a.optimal_quantity || 0), money(a.unit_cost)]);
  }
}

async function insertMovement(client: any, warehouse: any, productId: string, movementType: string, quantity: number, balanceAfter: number, unitCost: number, meta: MovementMeta) {
  const operationGroupId = meta.operationGroupId || randomUUID();
  const { rows } = await client.query(`
    INSERT INTO inventory_movements(
      product_id,location_id,work_order_id,movement_type,quantity,balance_after,unit_cost,stock_value_after,
      note,created_by,warehouse_id,destination_warehouse_id,supplier_id,document_number,operation_group_id,counterparty_name
    ) VALUES($1::uuid,$2,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::uuid,$16)
    RETURNING *
  `, [
    productId, warehouse.location_id, meta.workOrderId || null, movementType, quantity, balanceAfter, unitCost,
    money(balanceAfter * unitCost), meta.note || null, meta.createdBy, warehouse.id, meta.destinationWarehouseId || null,
    meta.supplierId || null, meta.documentNumber || null, operationGroupId, meta.counterpartyName || null,
  ]);
  return rows[0];
}

export async function postWarehouseReceipt(client: any, args: {
  warehouse: any;
  productId: string;
  quantity: number;
  incomingUnitCost: number;
  movementType?: string;
  meta: MovementMeta;
}) {
  const quantity = Number(args.quantity || 0);
  if (!(quantity > EPS)) throw inventoryError("A bevételezett mennyiségnek pozitívnak kell lennie.", "INVENTORY_INVALID_QUANTITY", 400);
  const balance = await balanceForUpdate(client, args.warehouse.id, args.productId);
  const currentQty = Number(balance.quantity || 0);
  const currentCost = Number(balance.unit_cost || 0);
  const after = currentQty + quantity;
  const setting = await inventorySetting(client, args.warehouse.location_id == null ? null : String(args.warehouse.location_id));
  const incoming = money(args.incomingUnitCost);
  let newCost = currentCost;
  if (setting.cost_method === "latest_receipt") newCost = incoming;
  else if (setting.cost_method === "product_cost") {
    const masterCost = money(await productMasterCost(client, args.productId));
    newCost = masterCost > 0 ? masterCost : incoming;
  } else newCost = after > EPS ? money((Math.max(0,currentQty)*currentCost + quantity*incoming) / after) : incoming;

  await client.query(`UPDATE inventory_warehouse_balances SET quantity=$2,unit_cost=$3,updated_at=now() WHERE id=$1`, [balance.id, after, newCost]);
  await syncLegacyInventoryAggregate(client, args.productId, args.warehouse.location_id == null ? null : String(args.warehouse.location_id));
  const movement = await insertMovement(client, args.warehouse, args.productId, args.movementType || "receipt", quantity, after, newCost, args.meta);
  return { warehouse_id: args.warehouse.id, quantity, balance_after: after, unit_cost: newCost, movement };
}

export async function postWarehouseIssue(client: any, args: {
  warehouse: any;
  productId: string;
  quantity: number;
  movementType?: string;
  meta: MovementMeta;
}) {
  const quantity = Number(args.quantity || 0);
  if (!(quantity > EPS)) throw inventoryError("A kiadott mennyiségnek pozitívnak kell lennie.", "INVENTORY_INVALID_QUANTITY", 400);
  const balance = await balanceForUpdate(client, args.warehouse.id, args.productId);
  const currentQty = Number(balance.quantity || 0);
  const after = currentQty - quantity;
  const setting = await inventorySetting(client, args.warehouse.location_id == null ? null : String(args.warehouse.location_id));
  if (setting.prevent_negative_stock !== false && after < -EPS) {
    throw inventoryError(`A(z) ${args.warehouse.name} raktár készlete nem elegendő. Elérhető: ${currentQty}, szükséges: ${quantity}.`, "INVENTORY_INSUFFICIENT_STOCK");
  }
  const unitCost = Number(balance.unit_cost || 0);
  await client.query(`UPDATE inventory_warehouse_balances SET quantity=$2,updated_at=now() WHERE id=$1`, [balance.id, after]);
  await syncLegacyInventoryAggregate(client, args.productId, args.warehouse.location_id == null ? null : String(args.warehouse.location_id));
  const movement = await insertMovement(client, args.warehouse, args.productId, args.movementType || "writeoff", -quantity, after, unitCost, args.meta);
  return { warehouse_id: args.warehouse.id, quantity: -quantity, balance_after: after, unit_cost: unitCost, movement };
}
