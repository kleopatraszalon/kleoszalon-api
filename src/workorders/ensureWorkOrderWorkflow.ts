import type { Pool } from 'pg';

async function runStage(pool:Pool,substage:string,sql:string){
  try{return await pool.query(sql)}
  catch(error:any){
    error.workOrderBootstrapSubstage=substage;
    throw error;
  }
}

/**
 * Idempotens munkalap workflow bootstrap.
 * A felhasználói audit-azonosítók szövegesek, mert a rendszer e-mailt,
 * numerikus user ID-t vagy külső principal azonosítót is tárolhat.
 */
export async function ensureWorkOrderWorkflow(pool: Pool) {
  await runStage(pool,'columns',`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS document_status text;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS arrival_at timestamptz;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS work_started_at timestamptz;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS work_finished_at timestamptz;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS started_at timestamptz;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS completed_at timestamptz;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS status_updated_at timestamptz NOT NULL DEFAULT now();
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
  `);

  // KRITIKUS sorrend: egy NOT VALID legacy CHECK a már meglévő hibás sorokra
  // bármely későbbi UPDATE-nél újra lefuthat. Ezért a document_status-hoz kötött
  // régi CHECK-eket az ELSŐ work_orders UPDATE előtt kell eltávolítani.
  await runStage(pool,'drop_legacy_document_status_checks',`
    DO $$
    DECLARE status_att smallint; r record;
    BEGIN
      SELECT attnum INTO status_att
        FROM pg_attribute
       WHERE attrelid='work_orders'::regclass
         AND attname='document_status'
         AND NOT attisdropped;
      IF status_att IS NOT NULL THEN
        FOR r IN
          SELECT conname
            FROM pg_constraint
           WHERE conrelid='work_orders'::regclass
             AND contype='c'
             AND status_att=ANY(conkey)
        LOOP
          EXECUTE format('ALTER TABLE work_orders DROP CONSTRAINT %I',r.conname);
        END LOOP;
      END IF;
    END $$;
  `);

  await runStage(pool,'sync_timestamps',`
    UPDATE work_orders
    SET started_at=COALESCE(started_at,work_started_at),
        work_started_at=COALESCE(work_started_at,started_at),
        completed_at=COALESCE(completed_at,work_finished_at),
        work_finished_at=COALESCE(work_finished_at,completed_at)
    WHERE started_at IS NULL OR work_started_at IS NULL OR completed_at IS NULL OR work_finished_at IS NULL;
  `);

  await runStage(pool,'actor_columns',`
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
  `);

  await runStage(pool,'normalize_document_status',`
    UPDATE work_orders
    SET document_status = CASE
      WHEN status IN ('completed','paid') THEN 'completed'
      WHEN status IN ('cancelled','canceled','no_show') THEN 'cancelled'
      WHEN status='in_progress' THEN 'open'
      ELSE 'draft'
    END
    WHERE document_status IS NULL
       OR document_status NOT IN ('draft','open','completed','cancelled');

    ALTER TABLE work_orders ALTER COLUMN document_status SET DEFAULT 'draft';
    ALTER TABLE work_orders ALTER COLUMN document_status SET NOT NULL;
  `);

  await runStage(pool,'indexes_and_history_schema',`
    CREATE INDEX IF NOT EXISTS work_orders_document_status_idx
      ON work_orders(document_status, created_at DESC);
    CREATE INDEX IF NOT EXISTS work_orders_status_idx ON work_orders(status);
    CREATE INDEX IF NOT EXISTS work_orders_started_at_idx ON work_orders(started_at);
    CREATE INDEX IF NOT EXISTS work_orders_completed_at_idx ON work_orders(completed_at);

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

  await runStage(pool,'canonical_document_status_check',`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='work_orders_document_status_chk') THEN
        ALTER TABLE work_orders ADD CONSTRAINT work_orders_document_status_chk
          CHECK (document_status IN ('draft','open','completed','cancelled')) NOT VALID;
      END IF;
    END $$;
    ALTER TABLE work_orders VALIDATE CONSTRAINT work_orders_document_status_chk;
  `);

  await runStage(pool,'initial_history',`
    INSERT INTO work_order_status_history(work_order_id,status_kind,from_status,to_status,changed_at,reason)
    SELECT w.id,'document',NULL,w.document_status,COALESCE(w.created_at,now()),'MIGRATION_INITIAL_STATE'
    FROM work_orders w
    WHERE NOT EXISTS (
      SELECT 1 FROM work_order_status_history h
      WHERE h.work_order_id=w.id AND h.status_kind='document'
    )
  `);
}
