import db from "../db";

let ensurePromise: Promise<void> | null = null;

/** Idempotent SaaS bootstrap for tenant, franchise and subscription lifecycle. */
export function ensureSaasCore(): Promise<void> {
  if (ensurePromise) return ensurePromise;
  ensurePromise=(async()=>{
    await db.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id bigserial PRIMARY KEY,slug text NOT NULL UNIQUE,name text NOT NULL,legal_name text,tax_number text,billing_email text,
        status text NOT NULL DEFAULT 'active',default_locale text NOT NULL DEFAULT 'hu-HU',default_currency text NOT NULL DEFAULT 'HUF',timezone text NOT NULL DEFAULT 'Europe/Budapest',
        created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
      INSERT INTO tenants(slug,name,legal_name,status) VALUES('kleopatra','Kleopátra Szépségszalonok','Kleoszalon Kft.','active') ON CONFLICT(slug) DO NOTHING;
      CREATE TABLE IF NOT EXISTS tenant_settings(tenant_id bigint PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,settings jsonb NOT NULL DEFAULT '{}'::jsonb,updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS tenant_branding(tenant_id bigint PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,app_name text,logo_url text,favicon_url text,primary_color text,secondary_color text,custom_domain text UNIQUE,email_sender_name text,updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS subscription_plans(id bigserial PRIMARY KEY,code text NOT NULL UNIQUE,name text NOT NULL,active boolean NOT NULL DEFAULT true,monthly_price numeric(14,2) NOT NULL DEFAULT 0,currency text NOT NULL DEFAULT 'HUF',max_locations integer,max_users integer,features jsonb NOT NULL DEFAULT '{}'::jsonb,created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS subscriptions(id bigserial PRIMARY KEY,tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,plan_id bigint NOT NULL REFERENCES subscription_plans(id),status text NOT NULL DEFAULT 'active',starts_at timestamptz NOT NULL DEFAULT now(),trial_ends_at timestamptz,current_period_end timestamptz,external_customer_id text,external_subscription_id text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
      ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS billing_provider text;
      ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS cancel_at_period_end boolean NOT NULL DEFAULT false;
      ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
      ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS grace_period_end timestamptz;
      ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS last_payment_status text;
      ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS last_payment_at timestamptz;
      CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_external_provider_uq ON subscriptions(billing_provider,external_subscription_id) WHERE external_subscription_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS subscription_events(
        id bigserial PRIMARY KEY,tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,subscription_id bigint REFERENCES subscriptions(id) ON DELETE SET NULL,
        event_type text NOT NULL,source text NOT NULL DEFAULT 'system',external_event_id text,payload jsonb NOT NULL DEFAULT '{}'::jsonb,created_at timestamptz NOT NULL DEFAULT now());
      CREATE UNIQUE INDEX IF NOT EXISTS subscription_events_external_uq ON subscription_events(source,external_event_id) WHERE external_event_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS subscription_events_tenant_idx ON subscription_events(tenant_id,created_at DESC);

      CREATE TABLE IF NOT EXISTS subscription_invoices(
        id bigserial PRIMARY KEY,tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,subscription_id bigint REFERENCES subscriptions(id) ON DELETE SET NULL,
        period_start timestamptz,period_end timestamptz,currency text NOT NULL DEFAULT 'HUF',net_amount numeric(14,2) NOT NULL DEFAULT 0,tax_amount numeric(14,2) NOT NULL DEFAULT 0,gross_amount numeric(14,2) NOT NULL DEFAULT 0,
        status text NOT NULL DEFAULT 'draft',due_at timestamptz,paid_at timestamptz,external_invoice_id text,provider_payload jsonb NOT NULL DEFAULT '{}'::jsonb,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
      CREATE UNIQUE INDEX IF NOT EXISTS subscription_invoices_external_uq ON subscription_invoices(external_invoice_id) WHERE external_invoice_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS subscription_invoices_tenant_idx ON subscription_invoices(tenant_id,created_at DESC);

      CREATE TABLE IF NOT EXISTS billing_webhook_events(
        id bigserial PRIMARY KEY,provider text NOT NULL,external_event_id text NOT NULL,event_type text,tenant_id bigint REFERENCES tenants(id) ON DELETE SET NULL,
        processing_status text NOT NULL DEFAULT 'received',payload jsonb NOT NULL DEFAULT '{}'::jsonb,error_message text,received_at timestamptz NOT NULL DEFAULT now(),processed_at timestamptz,
        UNIQUE(provider,external_event_id));

      CREATE TABLE IF NOT EXISTS tenant_features(tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,feature_key text NOT NULL,enabled boolean NOT NULL DEFAULT true,config jsonb NOT NULL DEFAULT '{}'::jsonb,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,feature_key));
      CREATE TABLE IF NOT EXISTS tenant_users(tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,user_id text NOT NULL,tenant_role text NOT NULL DEFAULT 'member',active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,user_id));
      CREATE TABLE IF NOT EXISTS franchise_networks(id bigserial PRIMARY KEY,tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,code text NOT NULL,name text NOT NULL,owner_legal_name text,royalty_percent numeric(8,4) NOT NULL DEFAULT 0,marketing_fee_percent numeric(8,4) NOT NULL DEFAULT 0,active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,code));
      CREATE TABLE IF NOT EXISTS franchise_members(id bigserial PRIMARY KEY,tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,franchise_network_id bigint NOT NULL REFERENCES franchise_networks(id) ON DELETE CASCADE,location_id text NOT NULL,member_type text NOT NULL DEFAULT 'franchise',agreement_number text,agreement_start date,agreement_end date,royalty_percent numeric(8,4),marketing_fee_percent numeric(8,4),active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(franchise_network_id,location_id));
      INSERT INTO subscription_plans(code,name,monthly_price,features) VALUES
        ('internal','Internal',0,'{"all_modules":true}'::jsonb),('start','Start',0,'{"booking":true,"crm":true}'::jsonb),
        ('pro','Pro',0,'{"booking":true,"crm":true,"hr":true,"inventory":true,"finance":true}'::jsonb),
        ('franchise','Franchise',0,'{"booking":true,"crm":true,"hr":true,"inventory":true,"finance":true,"marketing":true,"franchise":true,"mobile_app":true}'::jsonb),
        ('enterprise','Enterprise',0,'{"all_modules":true,"white_label":true,"api":true}'::jsonb) ON CONFLICT(code) DO NOTHING;
    `);
    const locationTable=await db.query(`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='locations' LIMIT 1`);
    if(locationTable.rowCount){await db.query(`ALTER TABLE locations ADD COLUMN IF NOT EXISTS tenant_id bigint`);await db.query(`UPDATE locations SET tenant_id=(SELECT id FROM tenants WHERE slug='kleopatra') WHERE tenant_id IS NULL`);await db.query(`CREATE INDEX IF NOT EXISTS locations_tenant_idx ON locations(tenant_id)`)}
    const userTable=await db.query(`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='users' LIMIT 1`);
    if(userTable.rowCount){await db.query(`INSERT INTO tenant_users(tenant_id,user_id,tenant_role,active) SELECT (SELECT id FROM tenants WHERE slug='kleopatra'),u.id::text,CASE WHEN lower(COALESCE(u.role::text,''))='admin' THEN 'owner' ELSE 'member' END,true FROM users u ON CONFLICT(tenant_id,user_id) DO NOTHING`)}
    await db.query(`INSERT INTO subscriptions(tenant_id,plan_id,status) SELECT t.id,p.id,'active' FROM tenants t JOIN subscription_plans p ON p.code='internal' WHERE t.slug='kleopatra' AND NOT EXISTS(SELECT 1 FROM subscriptions s WHERE s.tenant_id=t.id AND s.status IN('trial','active','past_due','suspended'))`);
  })().catch(error=>{ensurePromise=null;throw error});
  return ensurePromise;
}
export default ensureSaasCore;
