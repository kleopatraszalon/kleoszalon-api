import { randomUUID } from "crypto";
import { ensureInventoryOperationsSchema } from "./ensureInventoryOperationsSchema";
import { ensureInventoryHardeningSchema } from "./ensureInventoryHardeningSchema";
import { ensureInventoryLotSchema } from "./ensureInventoryLotSchema";
import { postWarehouseIssue, resolveInventoryWarehouse } from "./inventoryLedgerService";

const EPS = 0.0001;

type Purpose = "sale" | "consumption";
type Requirement = {
  productId: string;
  quantity: number;
  direct: number;
  material: number;
  purpose: Purpose;
};
type PlannedRequirement = Requirement & { warehouse: any };

export async function consumeWorkOrderInventory(client: any, workOrder: any, createdBy: string) {
  await ensureInventoryOperationsSchema();
  await ensureInventoryHardeningSchema();
  await ensureInventoryLotSchema();
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
  const rawPlans: PlannedRequirement[] = [];
  for (const r of requirements) {
    const warehouse = await resolveInventoryWarehouse(client, {
      locationId,
      productId: r.productId,
      purpose: r.purpose,
      requiredQuantity: r.quantity,
    });
    rawPlans.push({ ...r, warehouse });
  }

  const grouped = new Map<string, PlannedRequirement>();
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
  const operationGroupId = randomUUID();
  const consumed:any[]=[];

  for (const p of ordered) {
    const posted = await postWarehouseIssue(client, {
      warehouse: p.warehouse,
      productId: p.productId,
      quantity: p.quantity,
      movementType: "work_order_consumption",
      meta: {
        workOrderId: String(workOrder.id),
        operationGroupId,
        note: `Automatikus munkalap-fogyás · közvetlen termék: ${p.direct.toFixed(3)} · szolgáltatási anyagnorma: ${p.material.toFixed(3)} · raktár: ${p.warehouse.name}`,
        createdBy,
      },
    });
    consumed.push({
      product_id: p.productId,
      warehouse_id: p.warehouse.id,
      warehouse_name: p.warehouse.name,
      quantity: p.quantity,
      direct_quantity: p.direct,
      service_material_quantity: p.material,
      balance_after: posted.balance_after,
      unit_cost: posted.unit_cost,
      stock_value_after: Number(posted.balance_after || 0) * Number(posted.unit_cost || 0),
      lot_allocations: posted.lot_allocations || [],
    });
  }

  const productIds = Array.from(new Set(ordered.map((p) => p.productId)));
  const replenishment = locationId && productIds.length ? (await client.query(`
    SELECT DISTINCT ON(r.product_id) r.id::text,r.product_id::text,r.status,r.requested_quantity::numeric
    FROM salon_stock_requests r
    WHERE r.location_id=$1::uuid AND r.product_id=ANY($2::uuid[])
      AND r.status IN('requested','approved','partially_supplied')
    ORDER BY r.product_id,r.created_at DESC
  `, [locationId, productIds])).rows : [];

  return { consumed, replenishment_requests: replenishment, idempotent: false, operation_group_id: operationGroupId };
}
