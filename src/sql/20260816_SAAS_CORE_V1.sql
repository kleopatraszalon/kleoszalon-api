BEGIN;

-- ============================================================
-- VIR SaaS Core v1
-- Multi-tenant + franchise alapmodell, visszafelé kompatibilis módon.
-- A jelenlegi Kleopátra rendszer automatikusan az első tenant lesz.
-- ============================================================

CREATE TABLE IF NOT EXISTS tenants (
  id bigserial PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  legal_name text,
  tax_number text,
  billing_email text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','trial','suspended','cancelled')),
  default_locale text NOT NULL DEFAULT 'hu-HU',
  default_currency text NOT NULL DEFAULT 'HUF',
  timezone text NOT NULL DEFAULT 'Europe/Budapest',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO tenants (slug, name, legal_name, status)
VALUES ('kleopatra', 'Kleopátra Szépségszalonok', 'Kleoszalon Kft.', 'active')
ON CONFLICT (slug) DO NOTHING;

CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id bigint PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_branding (
  tenant_id bigint PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  app_name text,
  logo_url text,
  favicon_url text,
  primary_color text,
  secondary_color text,
  custom_domain text UNIQUE,
  email_sender_name text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscription_plans (
  id bigserial PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  monthly_price numeric(14,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'HUF',
  max_locations integer,
  max_users integer,
  features jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO subscription_plans (code, name, monthly_price, features)
VALUES
  ('internal', 'Internal', 0, '{"all_modules":true}'::jsonb),
  ('start', 'Start', 0, '{"booking":true,"crm":true}'::jsonb),
  ('pro', 'Pro', 0, '{"booking":true,"crm":true,"hr":true,"inventory":true,"finance":true}'::jsonb),
  ('franchise', 'Franchise', 0, '{"booking":true,"crm":true,"hr":true,"inventory":true,"finance":true,"marketing":true,"franchise":true,"mobile_app":true}'::jsonb),
  ('enterprise', 'Enterprise', 0, '{"all_modules":true,"white_label":true,"api":true}'::jsonb)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS subscriptions (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id bigint NOT NULL REFERENCES subscription_plans(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('trial','active','past_due','suspended','cancelled')),
  starts_at timestamptz NOT NULL DEFAULT now(),
  trial_ends_at timestamptz,
  current_period_end timestamptz,
  external_customer_id text,
  external_subscription_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_one_active_per_tenant_idx
  ON subscriptions(tenant_id)
  WHERE status IN ('trial','active','past_due','suspended');

INSERT INTO subscriptions (tenant_id, plan_id, status)
SELECT t.id, p.id, 'active'
FROM tenants t
JOIN subscription_plans p ON p.code='internal'
WHERE t.slug='kleopatra'
  AND NOT EXISTS (
    SELECT 1 FROM subscriptions s
    WHERE s.tenant_id=t.id AND s.status IN ('trial','active','past_due','suspended')
  );

CREATE TABLE IF NOT EXISTS tenant_features (
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  feature_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, feature_key)
);

CREATE TABLE IF NOT EXISTS franchise_networks (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  owner_legal_name text,
  royalty_percent numeric(8,4) NOT NULL DEFAULT 0,
  marketing_fee_percent numeric(8,4) NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS franchise_members (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  franchise_network_id bigint NOT NULL REFERENCES franchise_networks(id) ON DELETE CASCADE,
  location_id text NOT NULL,
  member_type text NOT NULL DEFAULT 'franchise' CHECK (member_type IN ('owned','franchise')),
  agreement_number text,
  agreement_start date,
  agreement_end date,
  royalty_percent numeric(8,4),
  marketing_fee_percent numeric(8,4),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (franchise_network_id, location_id)
);

CREATE TABLE IF NOT EXISTS tenant_users (
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  tenant_role text NOT NULL DEFAULT 'member',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

ALTER TABLE locations ADD COLUMN IF NOT EXISTS tenant_id bigint;

UPDATE locations
SET tenant_id = (SELECT id FROM tenants WHERE slug='kleopatra')
WHERE tenant_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='locations_tenant_fk'
  ) THEN
    ALTER TABLE locations
      ADD CONSTRAINT locations_tenant_fk
      FOREIGN KEY (tenant_id) REFERENCES tenants(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS locations_tenant_idx ON locations(tenant_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='users') THEN
    INSERT INTO tenant_users (tenant_id, user_id, tenant_role, active)
    SELECT (SELECT id FROM tenants WHERE slug='kleopatra'), u.id::text,
           CASE WHEN lower(COALESCE(u.role::text,''))='admin' THEN 'owner' ELSE 'member' END,
           true
    FROM users u
    ON CONFLICT (tenant_id, user_id) DO NOTHING;
  END IF;
END $$;

COMMIT;
