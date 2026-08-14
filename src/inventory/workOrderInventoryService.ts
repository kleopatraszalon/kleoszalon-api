import { randomUUID } from "crypto";
import { ensureInventoryOperationsSchema } from "./ensureInventoryOperationsSchema";
import { ensureInventoryHardeningSchema } from "./ensureInventoryHardeningSchema";

const EPS = 0.0001;
const money = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

type Purpose = "sale" | "consumption";
type Requirement = {
  productId: string;
  quantity: number;
  direct: number;
  material: number;
  purpose: Purpose;
};
type Plan = Requirement & {
  warehouse: any;
  balance: any;
  balanceAfter: number;
  unitCost: number;
};

function inventoryError(message: string, code: string) {
  const error: any = new Error(message);
  error.status = 409;
  error.publicCode = code;
  error.code = code;
  return error;
}

async function resolveWarehouse(client: any, locationId: string | null, purpose: Purpose, productId: string, quantity: number) {
  const { rows } = await client.query(`
    SELECT w.*,COALESCE(b.quantity,0)::numeric AS product_quantity
    FROM inventory_warehouses w
    LEFT JOIN inventory_warehouse_balances b ON b.warehouse_id=w.id AND b.product_id=$2::uuid
    WHERE w.active=true
      AND (($1::text IS NULL AND w.location_id IS NULL) OR w.location_id=$1::text)
    ORDER BY
      CASE WHEN COALESCE(b.quantity,0)>=$3 THEN 0 ELSE 1 END,
      CASE WHEN $4='consumption' AND w.is_default_consumption THEN 0
           WHEN $4='sale' AND w.is_default_sale THEN 0 ELSE 1 END,
      CASE WHEN $4='consumption' AND w.warehouse_type='consumable' THEN 0
           WHEN $4='sale' AND w.warehouse_type='retail' THEN 0 ELSE 1 END,
      w.sort_order,w.id
    LIMIT 1
  `, [locationId, productId, quantity, purpose]);
  if (!rows[0]) {
    throw inventoryError(
      `A munkalap készletlevonásához nincs aktív ${purpose === "consumption" ? "fogyóanyag" : "értékesítési"} raktár konfigurálva.`,
      "INVENTORY_WAREHOUSE_MISSING",
    );
  }
  return rows[0];
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

async function syncLegacyAggregate(client: any, productId: string, locationId: string | null) {
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

export async function consumeWorkOrderInventory(client: any, workOrder: any, createdBy: string) {
  await ensureInventoryOperationsSchema();
  await ensureInventoryHardeningSchema();
  if (workOrder.stock_consumed_at) return { consumed: [], replenishment_requests: [], idempotent: true };

  const direct = (await client.query(`
    SELECT product_id::text,SUM(quantity)::numeric quantity
    FROM work_order_items
    WHERE work_order_id=$1::uuid AND item_type='product' AND product_id IS NOT NULL
    GROUP BY product_id
  `, [workOrder.id])).rows;
  const material = (await client.query(`
    SELECT r.product_id::text,SUM(COALESCE(wi.quantity,1)*r.default_quantity)::numeric quantity
    FROM work_order_items wi
    JOIN service_material_requirements r ON r.service_id=wi.service_id AND r.active=true
    WHERE wi.work_order_id=$1::uuid AND wi.item_type='service' AND wi.service_id IS NOT NULL
    GROUP BY r.product_id
  `, [workOrder.id])).rows;

  const requirements: Requirement[] = [];
  for (const row of direct) {
    const quantity = Number(row.quantity || 0);
    if (quantity > EPS) requirements.push({ productId: String(row.product_id), quantity, direct: quantity, material: 0, purpose: "sale" });
  }
  for (const row of material) {
    const quantity = Number(row.quantity || 0);
    if (quantity > EPS) requirements.push({ productId: String(row.product_id), quantity, direct: 0, material: quantity, purpose: "consumption" });
  }
  if (!requirements.length) return { consumed: [], replenishment_requests: [], idempotent: false };

  const locationId = workOrder.location_id ? String(workOrder.location_id) : null;
  const rawPlans: Array<Requirement & { warehouse: any }> = [];
  for (const r of requirements) {
    const warehouse = await resolveWarehouse(client, locationId, r.purpose, r.productId, r.quantity);
    rawPlans.push({ ...r, warehouse });
  }

  const grouped = new Map<string, Requirement & { warehouse: any }>();
  for (const p of rawPlans) {
    const key = `${p.warehouse.id}:${p.productId}`;
    const current = grouped.get(key);
    if (current) {
      current.quantity += p.quantity;
      current.direct += p.direct;
      current.material += p.material;
    } else grouped.set(key, { ...p });
  }

  const ordered = Array.from(grouped.values()).sort((a, b) =>
    Number(a.warehouse.id) - Number(b.warehouse.id) || a.productId.localeCompare(b.productId),
  );
  const plans: Plan[] = [];
  for (const p of ordered) {
    const balance = await balanceForUpdate(client, p.warehouse.id, p.productId);
    const current = Number(balance?.quantity || 0);
    if (current + EPS < p.quantity) {
      const product = await client.query(`SELECT name FROM products WHERE id=$1::uuid`, [p.productId]);
      const name = product.rows[0]?.name || p.productId;
      throw inventoryError(
        `Nincs elegendő készlet: ${name} · ${p.warehouse.name}. Szükséges: ${p.quantity}, elérhető: ${current}.`,
        "INVENTORY_INSUFFICIENT_STOCK",
      );
    }
    plans.push({ ...p, balance, balanceAfter: current - p.quantity, unitCost: Number(balance?.unit_cost || 0) });
  }

  for (const p of plans) {
    await client.query(`UPDATE inventory_warehouse_balances SET quantity=$2,updated_at=now() WHERE id=$1`, [p.balance.id, p.balanceAfter]);
  }

  const productIds = Array.from(new Set(plans.map((p) => p.productId)));
  for (const productId of productIds) await syncLegacyAggregate(client, productId, locationId);

  const operationGroupId = randomUUID();
  const consumed: any[] = [];
  for (const p of plans) {
    const stockValueAfter = money(p.balanceAfter * p.unitCost);
    await client.query(`
      INSERT INTO inventory_movements(
        product_id,location_id,work_order_id,movement_type,quantity,balance_after,unit_cost,stock_value_after,
        note,created_by,warehouse_id,operation_group_id
      ) VALUES($1::uuid,$2::uuid,$3::uuid,'work_order_consumption',$4,$5,$6,$7,$8,$9,$10,$11::uuid)
      ON CONFLICT DO NOTHING
    `, [
      p.productId, locationId, workOrder.id, -p.quantity, p.balanceAfter, p.unitCost, stockValueAfter,
      `Automatikus munkalap-fogyás · közvetlen termék: ${p.direct.toFixed(3)} · szolgáltatási anyagnorma: ${p.material.toFixed(3)} · raktár: ${p.warehouse.name}`,
      createdBy, p.warehouse.id, operationGroupId,
    ]);
    consumed.push({
      product_id: p.productId,
      warehouse_id: p.warehouse.id,
      warehouse_name: p.warehouse.name,
      quantity: p.quantity,
      direct_quantity: p.direct,
      service_material_quantity: p.material,
      balance_after: p.balanceAfter,
      unit_cost: p.unitCost,
      stock_value_after: stockValueAfter,
    });
  }

  const replenishment = locationId ? (await client.query(`
    SELECT DISTINCT ON(r.product_id) r.id::text,r.product_id::text,r.status,r.requested_quantity::numeric
    FROM salon_stock_requests r
    WHERE r.location_id=$1::uuid AND r.product_id=ANY($2::uuid[])
      AND r.status IN('requested','approved','partially_supplied')
    ORDER BY r.product_id,r.created_at DESC
  `, [locationId, productIds])).rows : [];

  return { consumed, replenishment_requests: replenishment, idempotent: false };
}
