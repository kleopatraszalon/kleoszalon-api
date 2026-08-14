import { Router } from "express";
import db from "../db";
import { requireFeature } from "../middleware/featureAccess";
import { ensureProductTaxonomyReady } from "../inventory/ensureProductTaxonomy";
import { hasAnyRole } from "../security/roles";
import inventoryOperationsRouter from "./inventoryOperations";

const router = Router();
router.use(requireFeature("inventory"));
router.use("/ops", inventoryOperationsRouter);

type MovementType = "opening" | "receipt" | "adjustment";

function normalizeLocationId(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  return String(value);
}
function parseFiniteNumber(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function money(value: unknown) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}
const isGlobal = (req: any) => hasAnyRole(req.user?.role, ["admin", "manager"]);
const ownLocation = (req: any) => req.user?.location_id == null ? null : String(req.user.location_id);
const actor = (req: any) => req.user?.email || String(req.user?.id || "system");
function scopedLocation(req: any, requested: string | null) {
  if (isGlobal(req)) return requested;
  const own = ownLocation(req);
  if (!own) {
    const error: any = new Error("A készletkezeléshez telephely-hozzárendelés szükséges.");
    error.status = 403;
    throw error;
  }
  return own;
}
function canAccessLocation(req: any, locationId: string | null) {
  if (isGlobal(req)) return true;
  const own = ownLocation(req);
  return Boolean(own && locationId && own === locationId);
}

router.get("/", async (req: any, res, next) => {
  try {
    await ensureProductTaxonomyReady();
    const locationId = scopedLocation(req, normalizeLocationId(req.query.location_id));
    const params: any[] = [];
    const where = locationId === null
      ? "b.location_id IS NULL"
      : (params.push(locationId), `b.location_id::text = $${params.length}::text`);

    const result = await db.query(`
      SELECT
        b.id,b.product_id,p.name AS product_name,p.internal_code,p.brand,p.line_name,
        p.product_group_id,g.name AS product_group_name,g.code AS product_group_code,
        g.product_type_code,g.product_type_name,
        p.product_category_id,c.name AS product_category_name,c.code AS product_category_code,
        b.location_id,b.quantity,COALESCE(b.min_quantity,0)::numeric AS min_quantity,
        COALESCE(b.unit_cost,0)::numeric AS unit_cost,
        (COALESCE(b.quantity,0)*COALESCE(b.unit_cost,0))::numeric AS stock_value,
        CASE
          WHEN COALESCE(b.quantity,0)<=0 THEN 'out'
          WHEN COALESCE(b.quantity,0)<=COALESCE(b.min_quantity,0) THEN 'low'
          ELSE 'ok'
        END AS stock_status,
        b.updated_at
      FROM product_stock_balances b
      JOIN products p ON p.id=b.product_id
      LEFT JOIN product_groups g ON g.id=p.product_group_id
      LEFT JOIN product_categories c ON c.id=p.product_category_id
      WHERE ${where}
      ORDER BY COALESCE(g.sort_order,999),COALESCE(c.sort_order,999),p.name
    `, params);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.patch("/balances/:id/settings", async (req: any, res, next) => {
  try {
    const minQuantity = parseFiniteNumber(req.body?.min_quantity);
    const unitCost = parseFiniteNumber(req.body?.unit_cost);
    if (minQuantity === null || minQuantity < 0) return res.status(400).json({ message: "A minimum készlet nem lehet negatív." });
    if (unitCost === null || unitCost < 0) return res.status(400).json({ message: "A beszerzési ár nem lehet negatív." });
    const current = await db.query(`SELECT id,location_id::text FROM product_stock_balances WHERE id=$1`, [req.params.id]);
    if (!current.rows[0]) return res.status(404).json({ message: "A készletegyenleg nem található." });
    const currentLocation = current.rows[0].location_id == null ? null : String(current.rows[0].location_id);
    if (!canAccessLocation(req, currentLocation)) return res.status(403).json({ message: "Ehhez a telephelyi készlethez nincs jogosultsága." });
    const { rows } = await db.query(`
      UPDATE product_stock_balances
      SET min_quantity=$2,unit_cost=$3,updated_at=now()
      WHERE id=$1
      RETURNING id,product_id,location_id,quantity,min_quantity,unit_cost,(quantity*unit_cost)::numeric AS stock_value,updated_at
    `, [req.params.id, minQuantity, money(unitCost)]);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.get("/movements", async (req: any, res, next) => {
  try {
    await ensureProductTaxonomyReady();
    const productId = req.query.product_id ? String(req.query.product_id) : null;
    const requestedLocation = normalizeLocationId(req.query.location_id);
    const locationId = scopedLocation(req, requestedLocation);
    const limitRaw = Number(req.query.limit ?? 100);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 500) : 100;
    const params: any[] = [];
    const filters: string[] = [];
    if (productId) {
      params.push(productId);
      filters.push(`m.product_id=$${params.length}`);
    }
    if (locationId === null) filters.push("m.location_id IS NULL");
    else {
      params.push(locationId);
      filters.push(`m.location_id::text=$${params.length}::text`);
    }
    params.push(limit);
    const result = await db.query(`
      SELECT
        m.id,m.product_id,p.name AS product_name,
        g.name AS product_group_name,g.product_type_name,c.name AS product_category_name,
        m.location_id,m.work_order_id,m.movement_type,m.quantity,m.balance_after,
        COALESCE(m.unit_cost,0)::numeric AS unit_cost,
        COALESCE(m.stock_value_after,0)::numeric AS stock_value_after,
        m.note,m.created_by,m.created_at
      FROM inventory_movements m
      JOIN products p ON p.id=m.product_id
      LEFT JOIN product_groups g ON g.id=p.product_group_id
      LEFT JOIN product_categories c ON c.id=p.product_category_id
      WHERE ${filters.join(" AND ")}
      ORDER BY m.created_at DESC
      LIMIT $${params.length}
    `, params);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.post("/movements", async (req: any, res, next) => {
  const client = await db.connect();
  try {
    const productId = req.body?.product_id ? String(req.body.product_id) : "";
    const locationId = scopedLocation(req, normalizeLocationId(req.body?.location_id));
    const movementType = String(req.body?.movement_type ?? "").trim().toLowerCase() as MovementType;
    const requestedQuantity = parseFiniteNumber(req.body?.quantity);
    const incomingUnitCost = req.body?.unit_cost === "" || req.body?.unit_cost == null ? null : parseFiniteNumber(req.body?.unit_cost);
    const incomingMinQuantity = req.body?.min_quantity === "" || req.body?.min_quantity == null ? null : parseFiniteNumber(req.body?.min_quantity);
    const note = req.body?.note ? String(req.body.note).trim() : null;
    const createdBy = actor(req);

    if (!productId) return res.status(400).json({ message: "A product_id megadása kötelező." });
    if (!["opening", "receipt", "adjustment"].includes(movementType)) return res.status(400).json({ message: "Érvénytelen készletmozgás típus." });
    if (requestedQuantity === null) return res.status(400).json({ message: "A quantity csak szám lehet." });
    if ((movementType === "opening" || movementType === "receipt") && requestedQuantity < 0) return res.status(400).json({ message: "Nyitókészlet és bevételezés nem lehet negatív." });
    if (incomingUnitCost !== null && (incomingUnitCost < 0 || !Number.isFinite(incomingUnitCost))) return res.status(400).json({ message: "Érvénytelen beszerzési ár." });
    if (incomingMinQuantity !== null && (incomingMinQuantity < 0 || !Number.isFinite(incomingMinQuantity))) return res.status(400).json({ message: "Érvénytelen minimum készlet." });

    await client.query("BEGIN");
    const productCheck = await client.query(`SELECT id,name FROM products WHERE id=$1`, [productId]);
    if (!productCheck.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "A termék nem található." });
    }

    const balanceResult = await client.query(`
      SELECT id,quantity,COALESCE(unit_cost,0)::numeric AS unit_cost,COALESCE(min_quantity,0)::numeric AS min_quantity
      FROM product_stock_balances
      WHERE product_id=$1 AND (($2::text IS NULL AND location_id IS NULL) OR location_id::text=$2::text)
      FOR UPDATE
    `, [productId, locationId]);

    const currentBalance = Number(balanceResult.rows[0]?.quantity ?? 0);
    const currentUnitCost = Number(balanceResult.rows[0]?.unit_cost ?? 0);
    const currentMinQuantity = Number(balanceResult.rows[0]?.min_quantity ?? 0);
    let movementQuantity: number;
    let newBalance: number;
    if (movementType === "opening") {
      newBalance = requestedQuantity;
      movementQuantity = newBalance - currentBalance;
    } else {
      movementQuantity = requestedQuantity;
      newBalance = currentBalance + movementQuantity;
    }
    if (newBalance < 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "A készletkorrekció negatív készletet eredményezne.", current_balance: currentBalance, requested_change: movementQuantity });
    }

    let newUnitCost = currentUnitCost;
    if (movementType === "opening" && incomingUnitCost !== null) newUnitCost = money(incomingUnitCost);
    if (movementType === "receipt" && incomingUnitCost !== null && requestedQuantity > 0) {
      const currentValue = currentBalance * currentUnitCost;
      const incomingValue = requestedQuantity * incomingUnitCost;
      newUnitCost = newBalance > 0 ? money((currentValue + incomingValue) / newBalance) : money(incomingUnitCost);
    }
    const newMinQuantity = incomingMinQuantity === null ? currentMinQuantity : incomingMinQuantity;
    const stockValueAfter = money(newBalance * newUnitCost);

    if (balanceResult.rows[0]) {
      await client.query(`UPDATE product_stock_balances SET quantity=$2,unit_cost=$3,min_quantity=$4,updated_at=now() WHERE id=$1`, [balanceResult.rows[0].id, newBalance, newUnitCost, newMinQuantity]);
    } else {
      await client.query(`INSERT INTO product_stock_balances(product_id,location_id,quantity,unit_cost,min_quantity,updated_at) VALUES($1,$2,$3,$4,$5,now())`, [productId, locationId, newBalance, newUnitCost, newMinQuantity]);
    }

    const movement = await client.query(`
      INSERT INTO inventory_movements(product_id,location_id,movement_type,quantity,balance_after,unit_cost,stock_value_after,note,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING id,product_id,location_id,movement_type,quantity,balance_after,unit_cost,stock_value_after,note,created_by,created_at
    `, [productId, locationId, movementType, movementQuantity, newBalance, newUnitCost, stockValueAfter, note, createdBy]);

    await client.query("COMMIT");
    res.status(201).json({ product: productCheck.rows[0], movement: movement.rows[0], balance: newBalance, unit_cost: newUnitCost, min_quantity: newMinQuantity, stock_value: stockValueAfter });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    next(err);
  } finally {
    client.release();
  }
});

export default router;
