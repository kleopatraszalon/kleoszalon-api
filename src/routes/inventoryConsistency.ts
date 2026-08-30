import { Router } from "express";
import { randomUUID } from "crypto";
import db from "../db";
import { ensureInventoryOperationsSchema } from "../inventory/ensureInventoryOperationsSchema";
import { ensureInventoryLotSchema } from "../inventory/ensureInventoryLotSchema";
import { getProductLotTracking } from "../inventory/inventoryLotService";
import { postWarehouseIssue, postWarehouseReceipt } from "../inventory/inventoryLedgerService";
import { hasAnyRole } from "../security/roles";

const router = Router();
const EPS = 0.0001;

const actor = (req: any) => req.user?.email || String(req.user?.id || "system");
const isGlobal = (req: any) => hasAnyRole(req.user?.role, ["admin", "manager"]);
const canOperate = (req: any) => hasAnyRole(req.user?.role, ["admin", "manager", "location_manager", "salon_manager", "receptionist"]);
const canApprove = (req: any) => hasAnyRole(req.user?.role, ["admin", "manager", "location_manager"]);
const ownLocation = (req: any) => req.user?.location_id == null ? null : String(req.user.location_id);

function fail(status: number, message: string, code?: string): never {
  const error: any = new Error(message);
  error.status = status;
  error.publicCode = code;
  error.code = code;
  throw error;
}

function sendError(error: any, res: any, next: any) {
  if (error?.status) return res.status(Number(error.status)).json({ message: String(error.message || error), code: error.publicCode || error.code });
  return next(error);
}

function ensureOperator(req: any) {
  if (!canOperate(req)) fail(403, "Nincs jogosultsága készletművelet végrehajtásához.", "inventory_operation_forbidden");
}

function ensureWarehouseScope(req: any, warehouse: any) {
  if (isGlobal(req)) return;
  const own = ownLocation(req);
  const locationId = warehouse?.location_id == null ? null : String(warehouse.location_id);
  if (!own || locationId !== own) fail(403, "Ehhez a raktárhoz nincs jogosultsága.", "inventory_warehouse_forbidden");
}

async function warehouseById(client: any, id: unknown) {
  const { rows } = await client.query(`SELECT * FROM inventory_warehouses WHERE id=$1 AND active=true`, [String(id || "")]);
  if (!rows[0]) fail(404, "A raktár nem található vagy inaktív.", "inventory_warehouse_not_found");
  return rows[0];
}

router.use(async (_req, _res, next) => {
  try {
    await ensureInventoryOperationsSchema();
    await ensureInventoryLotSchema();
    await db.query(`ALTER TABLE inventory_transfers ADD COLUMN IF NOT EXISTS operation_group_id uuid NULL`);
    next();
  } catch (error) {
    next(error);
  }
});

/**
 * Canonical transfer dispatch.
 * Every item goes through inventoryLedgerService so aggregate stock, movement
 * audit and LOT/FEFO allocations are changed in one transaction.
 */
router.post("/transfers/:id/dispatch", async (req: any, res, next) => {
  const client = await db.connect();
  try {
    ensureOperator(req);
    await client.query("BEGIN");
    const head = await client.query(`
      SELECT t.*,sw.location_id AS source_location_id,sw.name AS source_warehouse_name
      FROM inventory_transfers t
      JOIN inventory_warehouses sw ON sw.id=t.source_warehouse_id
      WHERE t.id=$1
      FOR UPDATE OF t
    `, [req.params.id]);
    const transfer = head.rows[0];
    if (!transfer) fail(404, "Az áthelyezés nem található.");
    ensureWarehouseScope(req, { location_id: transfer.source_location_id });
    if (transfer.status !== "pending") fail(409, "Csak függő áthelyezés indítható el.");

    const source = await warehouseById(client, transfer.source_warehouse_id);
    const items = await client.query(`SELECT * FROM inventory_transfer_items WHERE transfer_id=$1 ORDER BY id FOR UPDATE`, [req.params.id]);
    if (!items.rows.length) fail(409, "Az áthelyezésnek nincs tétele.", "transfer_empty");
    const group = transfer.operation_group_id || randomUUID();

    for (const item of items.rows) {
      const quantity = Number(item.quantity || 0);
      if (!(quantity > EPS)) fail(400, `${item.product_name_snapshot || "Termék"}: az áthelyezett mennyiségnek pozitívnak kell lennie.`);
      const posted = await postWarehouseIssue(client, {
        warehouse: source,
        productId: String(item.product_id),
        quantity,
        movementType: "transfer_out",
        meta: {
          createdBy: actor(req),
          operationGroupId: group,
          destinationWarehouseId: transfer.destination_warehouse_id,
          documentNumber: transfer.document_number || null,
          note: `Áthelyezés ${transfer.document_number || `#${transfer.id}`} · kanonikus LOT/FEFO kiadás`,
        },
      });
      await client.query(`UPDATE inventory_transfer_items SET unit_cost=$2 WHERE id=$1`, [item.id, Number(posted.unit_cost || 0)]);
    }

    const { rows } = await client.query(`
      UPDATE inventory_transfers
      SET status='in_transit',operation_group_id=$2::uuid,dispatched_by=$3,dispatched_at=now(),updated_at=now()
      WHERE id=$1
      RETURNING *
    `, [req.params.id, group, actor(req)]);
    await client.query("COMMIT");
    return res.json(rows[0]);
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    return sendError(error, res, next);
  } finally {
    client.release();
  }
});

/**
 * Canonical transfer receipt. The operation_group_id created at dispatch is
 * reused so receiveTransferLots can preserve the original LOT identities.
 */
router.post("/transfers/:id/receive", async (req: any, res, next) => {
  const client = await db.connect();
  try {
    ensureOperator(req);
    await client.query("BEGIN");
    const head = await client.query(`
      SELECT t.*,dw.location_id AS destination_location_id,dw.name AS destination_warehouse_name
      FROM inventory_transfers t
      JOIN inventory_warehouses dw ON dw.id=t.destination_warehouse_id
      WHERE t.id=$1
      FOR UPDATE OF t
    `, [req.params.id]);
    const transfer = head.rows[0];
    if (!transfer) fail(404, "Az áthelyezés nem található.");
    ensureWarehouseScope(req, { location_id: transfer.destination_location_id });
    if (transfer.status !== "in_transit") fail(409, "Csak úton lévő áthelyezés vehető át.");
    if (!transfer.operation_group_id) fail(409, "Az áthelyezés LOT-kapcsoló azonosítója hiányzik. A kiadást újra kell indítani.", "INVENTORY_TRANSFER_LOT_LINK_MISSING");

    const destination = await warehouseById(client, transfer.destination_warehouse_id);
    const items = await client.query(`SELECT * FROM inventory_transfer_items WHERE transfer_id=$1 ORDER BY id FOR UPDATE`, [req.params.id]);
    if (!items.rows.length) fail(409, "Az áthelyezésnek nincs tétele.", "transfer_empty");

    for (const item of items.rows) {
      const quantity = Number(item.quantity || 0);
      if (!(quantity > EPS)) fail(400, `${item.product_name_snapshot || "Termék"}: az átvett mennyiségnek pozitívnak kell lennie.`);
      await postWarehouseReceipt(client, {
        warehouse: destination,
        productId: String(item.product_id),
        quantity,
        incomingUnitCost: Number(item.unit_cost || 0),
        movementType: "transfer_in",
        meta: {
          createdBy: actor(req),
          operationGroupId: String(transfer.operation_group_id),
          destinationWarehouseId: destination.id,
          documentNumber: transfer.document_number || null,
          note: `Áthelyezés ${transfer.document_number || `#${transfer.id}`} átvétele · LOT-azonosság megtartva`,
        },
      });
    }

    const { rows } = await client.query(`
      UPDATE inventory_transfers
      SET status='received',received_by=$2,received_at=now(),updated_at=now()
      WHERE id=$1
      RETURNING *
    `, [req.params.id, actor(req)]);
    await client.query("COMMIT");
    return res.json(rows[0]);
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    return sendError(error, res, next);
  } finally {
    client.release();
  }
});

/**
 * LOT-safe stocktake approval.
 * A product-level count cannot tell which tracked LOT is missing or extra, so a
 * non-zero difference on a LOT-tracked product is rejected instead of silently
 * corrupting the LOT ledger. Untracked products are posted through the same
 * canonical ledger used by all other stock changes.
 */
router.post("/stocktakes/:id/approve", async (req: any, res, next) => {
  const client = await db.connect();
  try {
    if (!canApprove(req)) fail(403, "Nincs jogosultsága leltár jóváhagyásához.");
    await client.query("BEGIN");
    const head = await client.query(`
      SELECT s.*,w.location_id,w.name AS warehouse_name,w.id AS warehouse_id
      FROM inventory_stocktakes s
      JOIN inventory_warehouses w ON w.id=s.warehouse_id
      WHERE s.id=$1
      FOR UPDATE OF s
    `, [req.params.id]);
    const stocktake = head.rows[0];
    if (!stocktake) fail(404, "A leltár nem található.");
    ensureWarehouseScope(req, stocktake);
    if (stocktake.status !== "submitted") fail(409, "Csak jóváhagyásra beküldött leltár zárható le.");

    const warehouse = await warehouseById(client, stocktake.warehouse_id);
    const items = await client.query(`
      SELECT i.*,p.name AS product_name,
             COALESCE(p.lot_tracking_enabled,false) AS lot_tracking_enabled
      FROM inventory_stocktake_items i
      JOIN products p ON p.id=i.product_id
      WHERE i.stocktake_id=$1
      ORDER BY i.id
      FOR UPDATE OF i
    `, [req.params.id]);
    const group = randomUUID();

    for (const item of items.rows) {
      const balance = await client.query(`
        SELECT * FROM inventory_warehouse_balances
        WHERE warehouse_id=$1 AND product_id=$2::uuid
        FOR UPDATE
      `, [stocktake.warehouse_id, item.product_id]);
      const current = Number(balance.rows[0]?.quantity || 0);
      const expected = Number(item.expected_quantity || 0);
      const counted = Number(item.counted_quantity || 0);
      if (Math.abs(current - expected) > EPS) {
        fail(409, `${item.product_name}: a készlet a leltár indítása óta megváltozott. Új leltár szükséges.`, "stocktake_stale");
      }
      const diff = counted - current;
      if (Math.abs(diff) <= EPS) continue;

      const tracking = await getProductLotTracking(client, String(item.product_id));
      if (tracking.lot_tracking_enabled) {
        fail(
          409,
          `${item.product_name}: ${diff > 0 ? "többlet" : "hiány"} van egy sarzskövetett terméknél. Előbb a Sarzs és lejárat oldalon rendezze a LOT-szintű mennyiséget, majd indítson új leltárt.`,
          "INVENTORY_LOT_STOCKTAKE_RECONCILIATION_REQUIRED",
        );
      }

      if (diff > 0) {
        await postWarehouseReceipt(client, {
          warehouse,
          productId: String(item.product_id),
          quantity: diff,
          incomingUnitCost: Number(balance.rows[0]?.unit_cost || item.unit_cost || 0),
          movementType: "stocktake_adjustment",
          meta: {
            createdBy: actor(req),
            operationGroupId: group,
            documentNumber: `ST-${stocktake.id}`,
            note: `Leltár #${stocktake.id} jóváhagyott többlet`,
          },
        });
      } else {
        await postWarehouseIssue(client, {
          warehouse,
          productId: String(item.product_id),
          quantity: Math.abs(diff),
          movementType: "stocktake_adjustment",
          meta: {
            createdBy: actor(req),
            operationGroupId: group,
            documentNumber: `ST-${stocktake.id}`,
            note: `Leltár #${stocktake.id} jóváhagyott hiány`,
          },
        });
      }
    }

    const { rows } = await client.query(`
      UPDATE inventory_stocktakes
      SET status='approved',approved_by=$2,approved_at=now(),updated_at=now()
      WHERE id=$1
      RETURNING *
    `, [req.params.id, actor(req)]);
    await client.query("COMMIT");
    return res.json(rows[0]);
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    return sendError(error, res, next);
  } finally {
    client.release();
  }
});

/**
 * Replenishment uses usable stock. Expired LOT quantity remains visible as
 * physical stock for audit/accounting, but it cannot postpone an order.
 */
router.get("/reorder-suggestions", async (req: any, res, next) => {
  try {
    const params: any[] = [];
    const filters = ["w.active=true", "b.min_quantity>0"];
    if (!isGlobal(req)) {
      const own = ownLocation(req);
      if (!own) return res.json([]);
      params.push(own);
      filters.push(`w.location_id=$${params.length}::text`);
    } else if (req.query.location_id !== undefined) {
      const locationId = String(req.query.location_id || "").trim() || null;
      if (locationId === null) filters.push("w.location_id IS NULL");
      else {
        params.push(locationId);
        filters.push(`w.location_id=$${params.length}::text`);
      }
    }
    if (req.query.warehouse_id) {
      params.push(String(req.query.warehouse_id));
      filters.push(`w.id=$${params.length}`);
    }

    const { rows } = await db.query(`
      WITH preferred AS (
        SELECT DISTINCT ON(pst.product_id)
          pst.product_id,pst.supplier_id,s.name AS supplier_name,pst.unit_price,
          pst.minimum_order_quantity,pst.lead_time_days,pst.preferred
        FROM product_supplier_terms pst
        JOIN suppliers s ON s.id=pst.supplier_id AND s.active=true
        WHERE pst.active=true
        ORDER BY pst.product_id,pst.preferred DESC,pst.unit_price ASC,pst.lead_time_days ASC
      ), expired AS (
        SELECT lb.warehouse_id,l.product_id,
               COALESCE(SUM(lb.quantity) FILTER (WHERE l.expires_at<CURRENT_DATE),0)::numeric AS expired_quantity
        FROM inventory_warehouse_lot_balances lb
        JOIN inventory_lots l ON l.id=lb.lot_id
        WHERE lb.quantity>0
        GROUP BY lb.warehouse_id,l.product_id
      ), scoped AS (
        SELECT b.id AS balance_id,b.product_id,p.name AS product_name,p.internal_code,p.brand,
               w.id AS warehouse_id,w.name AS warehouse_name,w.location_id,l.name AS location_name,
               b.quantity::numeric AS physical_quantity,
               COALESCE(e.expired_quantity,0)::numeric AS expired_quantity,
               CASE WHEN COALESCE(p.lot_tracking_enabled,false)
                    THEN GREATEST(b.quantity-COALESCE(e.expired_quantity,0),0)
                    ELSE b.quantity END::numeric AS usable_quantity,
               b.min_quantity::numeric,b.optimal_quantity::numeric,b.unit_cost::numeric
        FROM inventory_warehouse_balances b
        JOIN inventory_warehouses w ON w.id=b.warehouse_id
        JOIN products p ON p.id=b.product_id
        LEFT JOIN locations l ON l.id::text=w.location_id
        LEFT JOIN expired e ON e.warehouse_id=b.warehouse_id AND e.product_id=b.product_id
        WHERE ${filters.join(" AND ")}
      )
      SELECT s.balance_id,s.product_id::text,s.product_name,s.internal_code,s.brand,
             s.warehouse_id,s.warehouse_name,s.location_id,s.location_name,
             s.usable_quantity AS current_quantity,s.usable_quantity,
             s.physical_quantity,s.expired_quantity,s.min_quantity,s.optimal_quantity,
             COALESCE(pr.unit_price,s.unit_cost,0)::numeric AS unit_cost,
             pr.supplier_id,pr.supplier_name,pr.minimum_order_quantity,pr.lead_time_days,pr.preferred,
             GREATEST(
               CASE WHEN s.optimal_quantity>s.min_quantity THEN s.optimal_quantity ELSE s.min_quantity*2 END-s.usable_quantity,
               COALESCE(pr.minimum_order_quantity,0),0
             )::numeric AS suggested_quantity,
             (GREATEST(
               CASE WHEN s.optimal_quantity>s.min_quantity THEN s.optimal_quantity ELSE s.min_quantity*2 END-s.usable_quantity,
               COALESCE(pr.minimum_order_quantity,0),0
             )*COALESCE(pr.unit_price,s.unit_cost,0))::numeric AS expected_cost
      FROM scoped s
      LEFT JOIN preferred pr ON pr.product_id=s.product_id
      WHERE s.usable_quantity<=s.min_quantity
      ORDER BY COALESCE(s.location_name,'Központ'),s.warehouse_id,pr.supplier_name NULLS LAST,s.product_name
    `, params);
    return res.json(rows);
  } catch (error) {
    return sendError(error, res, next);
  }
});

export default router;
