import { Router } from "express";
import db from "../db";

const router = Router();

type MovementType = "opening" | "receipt" | "adjustment";

function normalizeLocationId(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  return String(value);
}

function parseFiniteNumber(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

router.get("/", async (req, res, next) => {
  try {
    const locationId = normalizeLocationId(req.query.location_id);
    const params: any[] = [];
    const where = locationId === null
      ? "b.location_id IS NULL"
      : (params.push(locationId), `b.location_id = $${params.length}`);

    const result = await db.query(
      `SELECT
         b.id,
         b.product_id,
         p.name AS product_name,
         b.location_id,
         b.quantity,
         b.updated_at
       FROM product_stock_balances b
       JOIN products p ON p.id = b.product_id
       WHERE ${where}
       ORDER BY p.name`,
      params
    );

    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.get("/movements", async (req, res, next) => {
  try {
    const productId = req.query.product_id ? String(req.query.product_id) : null;
    const locationId = normalizeLocationId(req.query.location_id);
    const limitRaw = Number(req.query.limit ?? 100);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 500) : 100;

    const params: any[] = [];
    const filters: string[] = [];

    if (productId) {
      params.push(productId);
      filters.push(`m.product_id = $${params.length}`);
    }

    if (req.query.location_id !== undefined) {
      if (locationId === null) {
        filters.push("m.location_id IS NULL");
      } else {
        params.push(locationId);
        filters.push(`m.location_id = $${params.length}`);
      }
    }

    params.push(limit);

    const result = await db.query(
      `SELECT
         m.id,
         m.product_id,
         p.name AS product_name,
         m.location_id,
         m.work_order_id,
         m.movement_type,
         m.quantity,
         m.balance_after,
         m.note,
         m.created_by,
         m.created_at
       FROM inventory_movements m
       JOIN products p ON p.id = m.product_id
       ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
       ORDER BY m.created_at DESC
       LIMIT $${params.length}`,
      params
    );

    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.post("/movements", async (req, res, next) => {
  const client = await db.connect();
  try {
    const productId = req.body?.product_id ? String(req.body.product_id) : "";
    const locationId = normalizeLocationId(req.body?.location_id);
    const movementType = String(req.body?.movement_type ?? "").trim().toLowerCase() as MovementType;
    const requestedQuantity = parseFiniteNumber(req.body?.quantity);
    const note = req.body?.note ? String(req.body.note).trim() : null;
    const createdBy = req.body?.created_by ?? null;

    if (!productId) {
      return res.status(400).json({ message: "A product_id megadása kötelező." });
    }
    if (!["opening", "receipt", "adjustment"].includes(movementType)) {
      return res.status(400).json({ message: "Érvénytelen készletmozgás típus." });
    }
    if (requestedQuantity === null) {
      return res.status(400).json({ message: "A quantity csak szám lehet." });
    }
    if ((movementType === "opening" || movementType === "receipt") && requestedQuantity < 0) {
      return res.status(400).json({ message: "Nyitókészlet és bevételezés nem lehet negatív." });
    }

    await client.query("BEGIN");

    const productCheck = await client.query(`SELECT id, name FROM products WHERE id = $1`, [productId]);
    if (!productCheck.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "A termék nem található." });
    }

    const balanceResult = await client.query(
      `SELECT id, quantity
       FROM product_stock_balances
       WHERE product_id = $1
         AND (($2::text IS NULL AND location_id IS NULL) OR location_id::text = $2::text)
       FOR UPDATE`,
      [productId, locationId]
    );

    const currentBalance = Number(balanceResult.rows[0]?.quantity ?? 0);
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
      return res.status(409).json({
        message: "A készletkorrekció negatív készletet eredményezne.",
        current_balance: currentBalance,
        requested_change: movementQuantity,
      });
    }

    if (balanceResult.rows[0]) {
      await client.query(
        `UPDATE product_stock_balances
         SET quantity = $2, updated_at = now()
         WHERE id = $1`,
        [balanceResult.rows[0].id, newBalance]
      );
    } else {
      await client.query(
        `INSERT INTO product_stock_balances (product_id, location_id, quantity, updated_at)
         VALUES ($1, $2, $3, now())`,
        [productId, locationId, newBalance]
      );
    }

    const movement = await client.query(
      `INSERT INTO inventory_movements
        (product_id, location_id, movement_type, quantity, balance_after, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, product_id, location_id, movement_type, quantity, balance_after, note, created_by, created_at`,
      [productId, locationId, movementType, movementQuantity, newBalance, note, createdBy]
    );

    await client.query("COMMIT");

    res.status(201).json({
      product: productCheck.rows[0],
      movement: movement.rows[0],
      balance: newBalance,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    next(err);
  } finally {
    client.release();
  }
});

export default router;
