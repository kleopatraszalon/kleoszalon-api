BEGIN;
SET LOCAL statement_timeout = 0;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- KLEO Enterprise Integrity V7
-- 1) tenant/location write integrity
-- 2) incoming invoice identity + arithmetic integrity
-- 3) loyalty top-up deduplication at DB boundary
-- 4) work-order reversal journal / idempotent audit core
-- 5) daily-action tenant/location ownership
-- ============================================================

DO $$
DECLARE default_tenant bigint;
BEGIN
  IF to_regclass('public.tenants') IS NULL THEN
    RAISE EXCEPTION 'tenants table missing: SaaS Core V1 must run first';
  END IF;
  SELECT id INTO default_tenant FROM tenants WHERE slug='kleopatra' LIMIT 1;
  IF default_tenant IS NULL THEN RAISE EXCEPTION 'kleopatra tenant missing'; END IF;

  IF to_regclass('public.finance_invoices') IS NOT NULL THEN
    ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS tenant_id bigint;
    UPDATE finance_invoices f SET tenant_id=l.tenant_id
      FROM locations l WHERE f.tenant_id IS NULL AND f.location_id IS NOT NULL AND f.location_id::text=l.id::text;
    UPDATE finance_invoices SET tenant_id=default_tenant WHERE tenant_id IS NULL;
    CREATE INDEX IF NOT EXISTS finance_invoices_tenant_idx ON finance_invoices(tenant_id);
  END IF;

  IF to_regclass('public.financial_movements') IS NOT NULL THEN
    ALTER TABLE financial_movements ADD COLUMN IF NOT EXISTS tenant_id bigint;
    UPDATE financial_movements f SET tenant_id=l.tenant_id
      FROM locations l WHERE f.tenant_id IS NULL AND f.location_id IS NOT NULL AND f.location_id::text=l.id::text;
    UPDATE financial_movements SET tenant_id=default_tenant WHERE tenant_id IS NULL;
    CREATE INDEX IF NOT EXISTS financial_movements_tenant_idx ON financial_movements(tenant_id);
  END IF;

  IF to_regclass('public.daily_action_campaigns') IS NOT NULL THEN
    ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS tenant_id bigint;
    ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS location_id uuid;
    UPDATE daily_action_campaigns d SET tenant_id=l.tenant_id
      FROM locations l WHERE d.tenant_id IS NULL AND d.location_id IS NOT NULL AND d.location_id::text=l.id::text;
    UPDATE daily_action_campaigns SET tenant_id=default_tenant WHERE tenant_id IS NULL;
    CREATE INDEX IF NOT EXISTS daily_action_campaigns_tenant_location_idx ON daily_action_campaigns(tenant_id,location_id,status,valid_from,valid_until);
  END IF;

  IF to_regclass('public.loyalty_accounts') IS NOT NULL THEN
    ALTER TABLE loyalty_accounts ADD COLUMN IF NOT EXISTS tenant_id bigint;
    UPDATE loyalty_accounts SET tenant_id=default_tenant WHERE tenant_id IS NULL;
    CREATE INDEX IF NOT EXISTS loyalty_accounts_tenant_idx ON loyalty_accounts(tenant_id);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION kleo_guard_tenant_location_consistency()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_tenant bigint;
BEGIN
  IF NEW.location_id IS NULL OR NEW.tenant_id IS NULL THEN RETURN NEW; END IF;
  SELECT tenant_id INTO expected_tenant FROM locations WHERE id::text=NEW.location_id::text LIMIT 1;
  IF expected_tenant IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='23503', MESSAGE='KLEO_TENANT_LOCATION_UNKNOWN';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM expected_tenant THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='KLEO_CROSS_TENANT_WRITE_BLOCKED';
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_invoices','financial_movements','daily_action_campaigns','purchase_orders','work_orders','appointments'] LOOP
    IF to_regclass('public.'||t) IS NOT NULL
       AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=t AND column_name='tenant_id')
       AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=t AND column_name='location_id') THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_tenant_location_guard ON %I',t,t);
      EXECUTE format('CREATE TRIGGER trg_%I_tenant_location_guard BEFORE INSERT OR UPDATE OF tenant_id,location_id ON %I FOR EACH ROW EXECUTE FUNCTION kleo_guard_tenant_location_consistency()',t,t);
    END IF;
  END LOOP;
END $$;

-- Incoming invoice integrity. Existing historical rows stay readable; new writes fail closed.
DO $$
BEGIN
  IF to_regclass('public.finance_invoices') IS NOT NULL THEN
    ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS supplier_invoice_number text;
    ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS supplier_id uuid;
    ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS source_receipt_id text;
    ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS source_purchase_order_id text;

    UPDATE finance_invoices
       SET supplier_invoice_number=NULLIF(btrim(invoice_no),'')
     WHERE direction='incoming' AND supplier_invoice_number IS NULL AND NULLIF(btrim(invoice_no),'') IS NOT NULL;

    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='chk_finance_invoices_totals_v7') THEN
      ALTER TABLE finance_invoices ADD CONSTRAINT chk_finance_invoices_totals_v7
        CHECK (abs(round((COALESCE(net_total,0)+COALESCE(vat_total,0)-COALESCE(gross_total,0))::numeric,2)) <= 0.01) NOT VALID;
    END IF;

    CREATE UNIQUE INDEX IF NOT EXISTS finance_invoices_incoming_supplier_no_uq_v7
      ON finance_invoices(tenant_id,COALESCE(supplier_id,'00000000-0000-0000-0000-000000000000'::uuid),lower(supplier_invoice_number))
      WHERE direction='incoming' AND supplier_invoice_number IS NOT NULL AND status NOT IN('void','cancelled','storno');

    CREATE UNIQUE INDEX IF NOT EXISTS finance_invoices_incoming_receipt_source_uq_v7
      ON finance_invoices(tenant_id,source_receipt_id)
      WHERE direction='incoming' AND source_receipt_id IS NOT NULL AND status NOT IN('void','cancelled','storno');
  END IF;
END $$;

-- Loyalty top-up integrity. The unique business reference is checked inside the same transaction
-- as the account balance mutation, so a duplicate INSERT rolls the entire balance change back.
DO $$
BEGIN
  IF to_regclass('public.loyalty_transactions') IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS loyalty_transactions_topup_reference_uq_v7
      ON loyalty_transactions(account_id,reference_id)
      WHERE transaction_type='balance_topup' AND reference_type='topup' AND reference_id IS NOT NULL;
  END IF;
  IF to_regclass('public.loyalty_sales') IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS loyalty_sales_wallet_topup_reference_uq_v7
      ON loyalty_sales(reference_id)
      WHERE sale_type='wallet_topup' AND reference_id IS NOT NULL;
  END IF;
END $$;

-- Work-order reversal audit core. Reversal is compensating, never destructive.
CREATE TABLE IF NOT EXISTS work_order_reversals(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL REFERENCES work_orders(id) ON DELETE RESTRICT,
  tenant_id bigint,
  location_id uuid,
  reason text NOT NULL CHECK(length(btrim(reason))>=5),
  requested_by text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'requested' CHECK(status IN('requested','processing','completed','failed')),
  reversal_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  original_archive_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  failure_code text,
  failure_detail text,
  UNIQUE(work_order_id),
  UNIQUE(idempotency_key)
);
CREATE INDEX IF NOT EXISTS work_order_reversals_tenant_location_idx ON work_order_reversals(tenant_id,location_id,created_at DESC);

CREATE OR REPLACE FUNCTION kleo_register_work_order_reversal(
  p_work_order_id uuid,
  p_reason text,
  p_requested_by text,
  p_idempotency_key text
) RETURNS work_order_reversals
LANGUAGE plpgsql AS $$
DECLARE w record; r work_order_reversals;
BEGIN
  IF length(btrim(COALESCE(p_reason,'')))<5 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='REVERSAL_REASON_REQUIRED'; END IF;
  IF length(btrim(COALESCE(p_idempotency_key,'')))<8 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='REVERSAL_IDEMPOTENCY_KEY_REQUIRED'; END IF;

  SELECT id,tenant_id,location_id,status,locked_at,archived_at,archive_hash
    INTO w FROM work_orders WHERE id=p_work_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='WORK_ORDER_NOT_FOUND'; END IF;
  IF w.locked_at IS NULL AND w.archived_at IS NULL AND COALESCE(w.status,'')<>'completed' THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WORK_ORDER_NOT_FINALIZED';
  END IF;

  SELECT * INTO r FROM work_order_reversals
   WHERE work_order_id=p_work_order_id OR idempotency_key=p_idempotency_key
   ORDER BY created_at LIMIT 1 FOR UPDATE;
  IF FOUND THEN RETURN r; END IF;

  INSERT INTO work_order_reversals(work_order_id,tenant_id,location_id,reason,requested_by,idempotency_key,original_archive_hash,reversal_payload)
  VALUES(p_work_order_id,w.tenant_id,w.location_id,btrim(p_reason),p_requested_by,p_idempotency_key,w.archive_hash,
    jsonb_build_object('source_status',w.status,'source_locked_at',w.locked_at,'source_archived_at',w.archived_at))
  RETURNING * INTO r;
  RETURN r;
END $$;

-- Daily-action location ownership is only created once the marketing module exists.
-- This keeps fresh bootstrap independent from request-time marketing schema creation.
DO $$
BEGIN
  IF to_regclass('public.daily_action_campaigns') IS NOT NULL THEN
    CREATE TABLE IF NOT EXISTS daily_action_campaign_locations(
      campaign_id uuid NOT NULL REFERENCES daily_action_campaigns(id) ON DELETE CASCADE,
      location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      tenant_id bigint NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(campaign_id,location_id)
    );
    CREATE INDEX IF NOT EXISTS daily_action_campaign_locations_tenant_idx ON daily_action_campaign_locations(tenant_id,location_id);
    DROP TRIGGER IF EXISTS trg_daily_action_campaign_locations_tenant_location_guard ON daily_action_campaign_locations;
    CREATE TRIGGER trg_daily_action_campaign_locations_tenant_location_guard
      BEFORE INSERT OR UPDATE OF tenant_id,location_id ON daily_action_campaign_locations
      FOR EACH ROW EXECUTE FUNCTION kleo_guard_tenant_location_consistency();
  END IF;
END $$;

DO $$
DECLARE t text; mismatch_count bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_invoices','financial_movements','daily_action_campaigns','purchase_orders','work_orders','appointments'] LOOP
    IF to_regclass('public.'||t) IS NOT NULL
       AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=t AND column_name='tenant_id')
       AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=t AND column_name='location_id') THEN
      EXECUTE format('SELECT count(*) FROM %I x JOIN locations l ON l.id::text=x.location_id::text WHERE x.location_id IS NOT NULL AND x.tenant_id IS DISTINCT FROM l.tenant_id',t) INTO mismatch_count;
      IF mismatch_count>0 THEN RAISE EXCEPTION 'Tenant/location mismatch in %: % rows',t,mismatch_count; END IF;
    END IF;
  END LOOP;
END $$;

COMMIT;
