import type { Pool } from 'pg';

/**
 * Idempotens munkalap workflow bootstrap.
 * A felhasználói audit-azonosítók szövegesek, mert a rendszer e-mailt,
 * numerikus user ID-t vagy külső principal azonosítót is tárolhat.
 */
export async function ensureWorkOrderWorkflow(pool: Pool) {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS document_status text;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS arrival_at timestamptz;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS work_started_at timestamptz;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS work_finished_at timestamptz;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS closed_at timestamptz;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS closed_by text;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS cancelled_by text;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS cancellation_reason text;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS cancellation_note text;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS base_discount_percent numeric(7,3) NOT NULL DEFAULT 0;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS applied_discount_percent numeric(7,3) NOT NULL DEFAULT 0;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS customer_balance_snapshot numeric(14,2);
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS total_gross numeric(14,2);
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS paid_total numeric(14,2);
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS amount_due numeric(14,2);

    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='work_orders'
          AND column_name='closed_by' AND data_type <> 'text'
      ) THEN
        ALTER TABLE work_orders ALTER COLUMN closed_by TYPE text USING closed_by::text;
      END IF;
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='work_orders'
          AND column_name='cancelled_by' AND data_type <> 'text'
      ) THEN
        ALTER TABLE work_orders ALTER COLUMN cancelled_by TYPE text USING cancelled_by::text;
      END IF;
    END $$;

    UPDATE work_orders
    SET document_status = CASE
      WHEN status='completed' THEN 'completed'
      WHEN status IN ('cancelled','no_show') THEN 'cancelled'
      WHEN status='in_progress' THEN 'open'
      ELSE 'draft'
    END
    WHERE document_status IS NULL;

    ALTER TABLE work_orders ALTER COLUMN document_status SET DEFAULT 'draft';
    ALTER TABLE work_orders ALTER COLUMN document_status SET NOT NULL;

    CREATE INDEX IF NOT EXISTS work_orders_document_status_idx
      ON work_orders(document_status, created_at DESC);

    CREATE TABLE IF NOT EXISTS work_order_status_history (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      work_order_id uuid NOT NULL REFERENCES work_orders(id) ON DELETE RESTRICT,
      status_kind text NOT NULL CHECK (status_kind IN ('document','service')),
      from_status text,
      to_status text NOT NULL,
      changed_at timestamptz NOT NULL DEFAULT now(),
      changed_by text,
      reason text,
      note text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    );

    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='work_order_status_history'
          AND column_name='changed_by' AND data_type <> 'text'
      ) THEN
        ALTER TABLE work_order_status_history ALTER COLUMN changed_by TYPE text USING changed_by::text;
      END IF;
    END $$;

    CREATE INDEX IF NOT EXISTS work_order_status_history_workorder_idx
      ON work_order_status_history(work_order_id, changed_at DESC);
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='work_orders_document_status_chk') THEN
        ALTER TABLE work_orders ADD CONSTRAINT work_orders_document_status_chk
          CHECK (document_status IN ('draft','open','completed','cancelled'));
      END IF;
    END $$;
  `);

  await pool.query(`
    INSERT INTO work_order_status_history(work_order_id,status_kind,from_status,to_status,changed_at,reason)
    SELECT w.id,'document',NULL,w.document_status,COALESCE(w.created_at,now()),'MIGRATION_INITIAL_STATE'
    FROM work_orders w
    WHERE NOT EXISTS (
      SELECT 1 FROM work_order_status_history h
      WHERE h.work_order_id=w.id AND h.status_kind='document'
    )
  `);
}
