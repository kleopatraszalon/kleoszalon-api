import { Router } from "express";
import db from "../db";
import type { AuthRequest } from "../middleware/auth";
import {
  requireIdempotencyKey,
  reverseFinancialMovement,
} from "../finance/financialIntegrity";

const router = Router();

const money = (value: unknown) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

const actor = (req: AuthRequest) =>
  req.user?.email || String(req.user?.id || "");

const locationFrom = (req: AuthRequest) =>
  String(req.query.location_id ?? req.body?.location_id ?? "").trim();

async function ensureSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS cash_register_movements (
      id bigserial PRIMARY KEY,
      location_id text NOT NULL,
      business_date date NOT NULL DEFAULT CURRENT_DATE,
      direction varchar(8) NOT NULL CHECK (direction IN ('in','out')),
      amount numeric(14,2) NOT NULL CHECK (amount > 0),
      reason_code varchar(40) NOT NULL DEFAULT 'other',
      note text,
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      voided_at timestamptz,
      voided_by text,
      void_reason text
    );

    CREATE INDEX IF NOT EXISTS cash_register_movements_scope_idx
      ON cash_register_movements (location_id, business_date DESC, created_at DESC);

    ALTER TABLE cash_register_closings
      ADD COLUMN IF NOT EXISTS cash_in numeric(14,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS cash_out numeric(14,2) NOT NULL DEFAULT 0;

    ALTER TABLE cash_register_movements
      ADD COLUMN IF NOT EXISTS finance_account_id uuid,
      ADD COLUMN IF NOT EXISTS financial_movement_id uuid,
      ADD COLUMN IF NOT EXISTS idempotency_key text,
      ADD COLUMN IF NOT EXISTS integrity_required boolean NOT NULL DEFAULT false;
  `);
}

const ready = async (_req: AuthRequest, _res: any, next: any) => {
  try {
    await ensureSchema();
    next();
  } catch (error) {
    next(error);
  }
};

async function getMovementTotals(locationId: string, businessDate: string) {
  const { rows } = await db.query(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE direction='in' AND voided_at IS NULL),0)::numeric AS cash_in,
       COALESCE(SUM(amount) FILTER (WHERE direction='out' AND voided_at IS NULL),0)::numeric AS cash_out
     FROM cash_register_movements
     WHERE location_id=$1 AND business_date=$2::date`,
    [locationId, businessDate],
  );
  const cashIn = money(rows[0]?.cash_in);
  const cashOut = money(rows[0]?.cash_out);
  return { cashIn, cashOut, net: money(cashIn - cashOut) };
}

async function isClosed(locationId: string, businessDate: string) {
  const { rows } = await db.query(
    `SELECT id FROM cash_register_closings
     WHERE location_id=$1 AND business_date=$2::date
     LIMIT 1`,
    [locationId, businessDate],
  );
  return Boolean(rows[0]);
}

router.get("/register-movements", ready, async (req: AuthRequest, res, next) => {
  try {
    const locationId = locationFrom(req);
    if (!locationId)
      return res.status(400).json({ message: "A telephely kiválasztása kötelező." });

    const businessDate = String(
      req.query.date || new Date().toISOString().slice(0, 10),
    );
    const { rows } = await db.query(
      `SELECT id,location_id,business_date,direction,amount,reason_code,note,
              created_by,created_at,voided_at,voided_by,void_reason
       FROM cash_register_movements
       WHERE location_id=$1 AND business_date=$2::date
       ORDER BY created_at DESC,id DESC`,
      [locationId, businessDate],
    );
    const totals = await getMovementTotals(locationId, businessDate);
    res.json({
      business_date: businessDate,
      location_id: locationId,
      cash_in: totals.cashIn,
      cash_out: totals.cashOut,
      net: totals.net,
      rows,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/register-movements", ready, async (req: AuthRequest, res, next) => {
  const client = await db.connect();
  try {
    const locationId = locationFrom(req);
    if (!locationId)
      return res.status(400).json({ message: "A telephely kiválasztása kötelező." });

    const businessDate = String(
      req.body?.business_date || new Date().toISOString().slice(0, 10),
    );
    const direction = String(req.body?.direction || "").toLowerCase();
    const amount = money(req.body?.amount);
    const reasonCode = String(req.body?.reason_code || "other").trim() || "other";
    const note = String(req.body?.note || "").trim() || null;
    const idempotencyKey = requireIdempotencyKey(req, "cash-register-movement");

    if (!new Set(["in", "out"]).has(direction))
      return res.status(400).json({ message: "Érvénytelen kasszamozgás irány." });
    if (!(amount > 0))
      return res.status(400).json({ message: "A kasszamozgás összege legyen pozitív." });
    await client.query("BEGIN");
    const existing = await client.query(
      `SELECT * FROM cash_register_movements
       WHERE location_id=$1 AND idempotency_key=$2 FOR UPDATE`,
      [locationId, idempotencyKey],
    );
    if (existing.rows[0]) {
      await client.query("COMMIT");
      return res.json({ ...existing.rows[0], idempotent: true });
    }
    const closed = await client.query(
      `SELECT id FROM cash_register_closings
       WHERE location_id=$1 AND business_date=$2::date LIMIT 1`,
      [locationId, businessDate],
    );
    if (closed.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        message: "A napi pénztár már le van zárva; új kasszamozgás nem rögzíthető.",
      });
    }
    const account = await client.query(
      `SELECT * FROM financial_accounts
       WHERE active=true AND account_type='cash'
         AND (location_id::text=$1 OR location_id IS NULL)
       ORDER BY CASE WHEN location_id::text=$1 THEN 0 ELSE 1 END,
                is_default DESC,sort_order,name
       FOR UPDATE LIMIT 1`,
      [locationId],
    );
    if (!account.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        message: "A telephelyhez nincs aktív készpénzes pénzügyi számla konfigurálva.",
      });
    }
    const postingGroupId = (
      await client.query("SELECT gen_random_uuid() AS id")
    ).rows[0].id;
    const ledger = await client.query(
      `INSERT INTO financial_movements
       (location_id,account_id,direction,amount,occurred_at,reference_type,
        counterparty,note,created_by,payment_status,posting_group_id,idempotency_key)
       VALUES ($1::uuid,$2::uuid,$3,$4,$5::date,'cash_register',$6,$7,$8,
               'posted',$9::uuid,$10)
       RETURNING *`,
      [
        locationId,
        account.rows[0].id,
        direction === "in" ? "income" : "expense",
        amount,
        businessDate,
        reasonCode,
        note,
        actor(req),
        postingGroupId,
        `${idempotencyKey}:ledger`,
      ],
    );
    const { rows } = await client.query(
      `INSERT INTO cash_register_movements
       (location_id,business_date,direction,amount,reason_code,note,created_by,
        finance_account_id,financial_movement_id,idempotency_key,integrity_required)
       VALUES ($1,$2::date,$3,$4,$5,$6,$7,$8::uuid,$9::uuid,$10,true)
       RETURNING *`,
      [
        locationId,
        businessDate,
        direction,
        amount,
        reasonCode,
        note,
        actor(req),
        account.rows[0].id,
        ledger.rows[0].id,
        idempotencyKey,
      ],
    );
    await client.query("COMMIT");
    res.status(201).json(rows[0]);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    next(error);
  } finally {
    client.release();
  }
});

router.post("/register-movements/:id/void", ready, async (req: AuthRequest, res, next) => {
  const client = await db.connect();
  try {
    const locationId = locationFrom(req);
    if (!locationId)
      return res.status(400).json({ message: "A telephely kiválasztása kötelező." });

    const reason = String(req.body?.reason || "").trim();
    if (!reason)
      return res.status(400).json({ message: "A visszavonás indoka kötelező." });

    await client.query("BEGIN");
    const locked = await client.query(
      `SELECT *,to_char(business_date,'YYYY-MM-DD') AS business_date_key
       FROM cash_register_movements
       WHERE id=$1 AND location_id=$2
       FOR UPDATE`,
      [req.params.id, locationId],
    );
    const movement = locked.rows[0];
    if (!movement) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "A kasszamozgás nem található." });
    }
    if (movement.voided_at) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "A kasszamozgás már vissza van vonva." });
    }
    if (await isClosed(locationId, String(movement.business_date_key))) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        message: "Lezárt napi pénztár kasszamozgása nem vonható vissza.",
      });
    }

    if (!movement.financial_movement_id && movement.integrity_required) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        message: "A kasszamozgás pénzügyi főkönyvi kapcsolata hiányzik; vezetői egyeztetés szükséges.",
      });
    }
    if (movement.financial_movement_id) {
      await reverseFinancialMovement(client, {
        movementId: String(movement.financial_movement_id),
        actor: actor(req),
        reason,
        locationId,
        includeFees: false,
      });
    }

    const { rows } = await client.query(
      `UPDATE cash_register_movements
       SET voided_at=now(),voided_by=$2,void_reason=$3
       WHERE id=$1
       RETURNING *`,
      [req.params.id, actor(req), reason],
    );
    await client.query("COMMIT");
    res.json(rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.get("/daily-summary", ready, async (req: AuthRequest, res, next) => {
  try {
    const locationId = locationFrom(req);
    if (!locationId) return next();

    const businessDate = String(
      req.query.date || new Date().toISOString().slice(0, 10),
    );
    const payment = await db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN wp.payment_method='cash' THEN wp.amount ELSE 0 END),0)::numeric AS cash_sales,
         COALESCE(SUM(CASE WHEN wp.payment_method='card' THEN wp.amount ELSE 0 END),0)::numeric AS card_sales,
         COALESCE(SUM(CASE WHEN wp.payment_method='transfer' THEN wp.amount ELSE 0 END),0)::numeric AS transfer_sales,
         COALESCE(SUM(CASE WHEN wp.payment_method='voucher' THEN wp.amount ELSE 0 END),0)::numeric AS voucher_sales,
         COALESCE(SUM(CASE WHEN wp.payment_method='other' THEN wp.amount ELSE 0 END),0)::numeric AS other_sales,
         COUNT(DISTINCT wp.work_order_id)::int AS workorder_count
       FROM work_order_payments wp
       JOIN work_orders wo ON wo.id=wp.work_order_id
       WHERE wp.paid_at::date=$1::date AND wo.location_id::text=$2`,
      [businessDate, locationId],
    );
    const orderTotals = await db.query(
      `SELECT COALESCE(SUM(tip_amount),0)::numeric AS tips,
              COALESCE(SUM(discount_amount),0)::numeric AS discounts
       FROM work_orders
       WHERE financial_closed_at::date=$1::date AND location_id::text=$2`,
      [businessDate, locationId],
    );
    const movements = await getMovementTotals(locationId, businessDate);

    res.json({
      business_date: businessDate,
      location_id: locationId,
      cash_sales: money(payment.rows[0]?.cash_sales),
      card_sales: money(payment.rows[0]?.card_sales),
      transfer_sales: money(payment.rows[0]?.transfer_sales),
      voucher_sales: money(payment.rows[0]?.voucher_sales),
      other_sales: money(payment.rows[0]?.other_sales),
      tips: money(orderTotals.rows[0]?.tips),
      discounts: money(orderTotals.rows[0]?.discounts),
      workorder_count: Number(payment.rows[0]?.workorder_count || 0),
      cash_in: movements.cashIn,
      cash_out: movements.cashOut,
      net_cash_movement: movements.net,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/daily-close", ready, async (req: AuthRequest, res, next) => {
  try {
    const locationId = locationFrom(req);
    if (!locationId) return next();

    const businessDate = String(
      req.body?.business_date || new Date().toISOString().slice(0, 10),
    );
    const openingCash = Math.max(0, money(req.body?.opening_cash));
    const countedCash = Math.max(0, money(req.body?.counted_cash));

    const payment = await db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN wp.payment_method='cash' THEN wp.amount ELSE 0 END),0)::numeric AS cash_sales,
         COALESCE(SUM(CASE WHEN wp.payment_method='card' THEN wp.amount ELSE 0 END),0)::numeric AS card_sales,
         COALESCE(SUM(CASE WHEN wp.payment_method='transfer' THEN wp.amount ELSE 0 END),0)::numeric AS transfer_sales,
         COALESCE(SUM(CASE WHEN wp.payment_method='voucher' THEN wp.amount ELSE 0 END),0)::numeric AS voucher_sales,
         COALESCE(SUM(CASE WHEN wp.payment_method='other' THEN wp.amount ELSE 0 END),0)::numeric AS other_sales
       FROM work_order_payments wp
       JOIN work_orders wo ON wo.id=wp.work_order_id
       WHERE wp.paid_at::date=$1::date AND wo.location_id::text=$2`,
      [businessDate, locationId],
    );
    const orderTotals = await db.query(
      `SELECT COALESCE(SUM(tip_amount),0)::numeric AS tips,
              COALESCE(SUM(discount_amount),0)::numeric AS discounts
       FROM work_orders
       WHERE financial_closed_at::date=$1::date AND location_id::text=$2`,
      [businessDate, locationId],
    );
    const movements = await getMovementTotals(locationId, businessDate);
    const p = payment.rows[0] || {};
    const expectedCash = money(
      openingCash + money(p.cash_sales) + movements.cashIn - movements.cashOut,
    );
    const difference = money(countedCash - expectedCash);

    const { rows } = await db.query(
      `INSERT INTO cash_register_closings
       (location_id,business_date,opening_cash,cash_sales,card_sales,transfer_sales,voucher_sales,other_sales,
        tips,discounts,cash_in,cash_out,expected_cash,counted_cash,difference,note,closed_by)
       VALUES ($1,$2::date,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (location_id,business_date) DO UPDATE SET
         opening_cash=EXCLUDED.opening_cash,
         cash_sales=EXCLUDED.cash_sales,
         card_sales=EXCLUDED.card_sales,
         transfer_sales=EXCLUDED.transfer_sales,
         voucher_sales=EXCLUDED.voucher_sales,
         other_sales=EXCLUDED.other_sales,
         tips=EXCLUDED.tips,
         discounts=EXCLUDED.discounts,
         cash_in=EXCLUDED.cash_in,
         cash_out=EXCLUDED.cash_out,
         expected_cash=EXCLUDED.expected_cash,
         counted_cash=EXCLUDED.counted_cash,
         difference=EXCLUDED.difference,
         note=EXCLUDED.note,
         closed_by=EXCLUDED.closed_by,
         closed_at=now()
       RETURNING *`,
      [
        locationId,
        businessDate,
        openingCash,
        money(p.cash_sales),
        money(p.card_sales),
        money(p.transfer_sales),
        money(p.voucher_sales),
        money(p.other_sales),
        money(orderTotals.rows[0]?.tips),
        money(orderTotals.rows[0]?.discounts),
        movements.cashIn,
        movements.cashOut,
        expectedCash,
        countedCash,
        difference,
        req.body?.note || null,
        actor(req),
      ],
    );
    res.status(201).json(rows[0]);
  } catch (error) {
    next(error);
  }
});

export default router;
