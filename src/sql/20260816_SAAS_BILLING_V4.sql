BEGIN;

ALTER TABLE IF EXISTS subscriptions ADD COLUMN IF NOT EXISTS billing_provider text;
ALTER TABLE IF EXISTS subscriptions ADD COLUMN IF NOT EXISTS cancel_at_period_end boolean NOT NULL DEFAULT false;
ALTER TABLE IF EXISTS subscriptions ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE IF EXISTS subscriptions ADD COLUMN IF NOT EXISTS grace_period_end timestamptz;
ALTER TABLE IF EXISTS subscriptions ADD COLUMN IF NOT EXISTS last_payment_status text;
ALTER TABLE IF EXISTS subscriptions ADD COLUMN IF NOT EXISTS last_payment_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_external_provider_uq ON subscriptions(billing_provider,external_subscription_id) WHERE external_subscription_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS subscription_events(
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id bigint REFERENCES subscriptions(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  source text NOT NULL DEFAULT 'system',
  external_event_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS subscription_events_external_uq ON subscription_events(source,external_event_id) WHERE external_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS subscription_events_tenant_idx ON subscription_events(tenant_id,created_at DESC);

CREATE TABLE IF NOT EXISTS subscription_invoices(
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id bigint REFERENCES subscriptions(id) ON DELETE SET NULL,
  period_start timestamptz,
  period_end timestamptz,
  currency text NOT NULL DEFAULT 'HUF',
  net_amount numeric(14,2) NOT NULL DEFAULT 0,
  tax_amount numeric(14,2) NOT NULL DEFAULT 0,
  gross_amount numeric(14,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft',
  due_at timestamptz,
  paid_at timestamptz,
  external_invoice_id text,
  provider_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS subscription_invoices_external_uq ON subscription_invoices(external_invoice_id) WHERE external_invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS subscription_invoices_tenant_idx ON subscription_invoices(tenant_id,created_at DESC);

CREATE TABLE IF NOT EXISTS billing_webhook_events(
  id bigserial PRIMARY KEY,
  provider text NOT NULL,
  external_event_id text NOT NULL,
  event_type text,
  tenant_id bigint REFERENCES tenants(id) ON DELETE SET NULL,
  processing_status text NOT NULL DEFAULT 'received',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE(provider,external_event_id)
);

COMMIT;
