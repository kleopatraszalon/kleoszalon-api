BEGIN;

CREATE TABLE IF NOT EXISTS franchise_revenue_entries(
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  franchise_network_id bigint NOT NULL REFERENCES franchise_networks(id) ON DELETE CASCADE,
  franchise_member_id bigint NOT NULL REFERENCES franchise_members(id) ON DELETE CASCADE,
  location_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  currency text NOT NULL DEFAULT 'HUF',
  net_revenue numeric(16,2) NOT NULL CHECK(net_revenue>=0),
  source_type text NOT NULL,
  source_id text NOT NULL,
  source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'posted' CHECK(status IN('posted','reversed')),
  reversed_entry_id bigint REFERENCES franchise_revenue_entries(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,source_type,source_id)
);
CREATE INDEX IF NOT EXISTS franchise_revenue_period_idx ON franchise_revenue_entries(tenant_id,occurred_at,location_id) WHERE status='posted';

CREATE TABLE IF NOT EXISTS franchise_settlements(
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  franchise_network_id bigint NOT NULL REFERENCES franchise_networks(id) ON DELETE CASCADE,
  franchise_member_id bigint NOT NULL REFERENCES franchise_members(id) ON DELETE CASCADE,
  location_id text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  currency text NOT NULL DEFAULT 'HUF',
  revenue_base numeric(16,2) NOT NULL DEFAULT 0,
  royalty_percent numeric(8,4) NOT NULL DEFAULT 0,
  marketing_fee_percent numeric(8,4) NOT NULL DEFAULT 0,
  royalty_amount numeric(16,2) NOT NULL DEFAULT 0,
  marketing_fee_amount numeric(16,2) NOT NULL DEFAULT 0,
  total_due numeric(16,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft' CHECK(status IN('draft','approved','paid','void')),
  approved_at timestamptz,
  approved_by text,
  paid_at timestamptz,
  payment_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,franchise_member_id,period_start,period_end,currency)
);
CREATE INDEX IF NOT EXISTS franchise_settlement_period_idx ON franchise_settlements(tenant_id,period_start,status);

CREATE TABLE IF NOT EXISTS franchise_settlement_events(
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  settlement_id bigint NOT NULL REFERENCES franchise_settlements(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  actor_user_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
