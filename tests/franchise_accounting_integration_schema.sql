CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE tenants(id bigserial PRIMARY KEY,name text NOT NULL);
CREATE TABLE locations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id bigint REFERENCES tenants(id),name text NOT NULL);
CREATE TABLE franchise_networks(id bigserial PRIMARY KEY,tenant_id bigint NOT NULL REFERENCES tenants(id),name text NOT NULL);
CREATE TABLE franchise_members(
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  franchise_network_id bigint NOT NULL REFERENCES franchise_networks(id),
  location_id text NOT NULL,
  member_type text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE franchise_revenue_entries(
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  franchise_network_id bigint NOT NULL REFERENCES franchise_networks(id),
  franchise_member_id bigint NOT NULL REFERENCES franchise_members(id),
  location_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  currency text NOT NULL DEFAULT 'HUF',
  net_revenue numeric(16,2) NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'posted',
  UNIQUE(tenant_id,source_type,source_id)
);
CREATE TABLE franchise_settlements(
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  franchise_network_id bigint NOT NULL REFERENCES franchise_networks(id),
  franchise_member_id bigint NOT NULL REFERENCES franchise_members(id),
  location_id text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  currency text NOT NULL DEFAULT 'HUF',
  royalty_amount numeric(16,2) NOT NULL DEFAULT 0,
  marketing_fee_amount numeric(16,2) NOT NULL DEFAULT 0,
  total_due numeric(16,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'approved',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE finance_invoices(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id text,
  direction text NOT NULL,
  invoice_no text,
  document_kind text,
  issued_at timestamptz,
  work_order_id uuid,
  currency text DEFAULT 'HUF',
  net_total numeric(16,2) DEFAULT 0,
  vat_total numeric(16,2) DEFAULT 0,
  gross_total numeric(16,2) DEFAULT 0,
  status text DEFAULT 'draft'
);
