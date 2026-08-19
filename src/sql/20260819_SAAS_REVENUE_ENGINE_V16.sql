BEGIN;

ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS annual_price numeric(14,2);
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS onboarding_fee numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS trial_days integer NOT NULL DEFAULT 0;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS recommended boolean NOT NULL DEFAULT false;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS public_visible boolean NOT NULL DEFAULT false;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS booking_commission_percent numeric(6,3) NOT NULL DEFAULT 0;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS addons jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS billing_interval text NOT NULL DEFAULT 'month';
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS next_retry_at timestamptz;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS dunning_step integer NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS payment_method_status text;

CREATE TABLE IF NOT EXISTS billing_checkout_sessions(
 id bigserial PRIMARY KEY,
 tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 subscription_id bigint REFERENCES subscriptions(id) ON DELETE SET NULL,
 provider text NOT NULL,
 external_session_id text NOT NULL,
 plan_code text NOT NULL,
 billing_interval text NOT NULL CHECK(billing_interval IN('month','year')),
 status text NOT NULL DEFAULT 'created',
 amount numeric(14,2) NOT NULL DEFAULT 0,
 currency text NOT NULL DEFAULT 'HUF',
 coupon_code text,
 checkout_url text,
 expires_at timestamptz,
 created_by text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(provider,external_session_id)
);
CREATE INDEX IF NOT EXISTS billing_checkout_tenant_idx ON billing_checkout_sessions(tenant_id,created_at DESC);

CREATE TABLE IF NOT EXISTS subscription_coupons(
 id bigserial PRIMARY KEY,
 code text NOT NULL UNIQUE,
 description text,
 percent_off numeric(6,2) NOT NULL CHECK(percent_off>0 AND percent_off<=100),
 valid_from timestamptz NOT NULL DEFAULT now(),
 valid_until timestamptz,
 max_redemptions integer,
 redemption_count integer NOT NULL DEFAULT 0,
 active boolean NOT NULL DEFAULT true,
 plan_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS subscription_coupon_redemptions(
 id bigserial PRIMARY KEY,
 coupon_id bigint NOT NULL REFERENCES subscription_coupons(id),
 tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 subscription_id bigint REFERENCES subscriptions(id) ON DELETE SET NULL,
 external_session_id text,
 redeemed_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(coupon_id,tenant_id)
);

UPDATE subscription_plans SET monthly_price=29900,annual_price=299000,onboarding_fee=49900,trial_days=14,recommended=false,public_visible=true,booking_commission_percent=0,max_locations=1,max_users=5,
 addons='{"extra_location_monthly":19900,"ai_plus_monthly":9900,"white_label_monthly":39900,"branded_app_monthly":49900}'::jsonb WHERE code='start';
UPDATE subscription_plans SET monthly_price=59900,annual_price=599000,onboarding_fee=99900,trial_days=14,recommended=true,public_visible=true,booking_commission_percent=0,max_locations=1,max_users=15,
 addons='{"extra_location_monthly":19900,"ai_plus_monthly":9900,"white_label_monthly":39900,"branded_app_monthly":49900}'::jsonb WHERE code='pro';
UPDATE subscription_plans SET monthly_price=149900,annual_price=1499000,onboarding_fee=299000,trial_days=0,recommended=false,public_visible=true,booking_commission_percent=0,max_locations=5,max_users=50 WHERE code='franchise';
UPDATE subscription_plans SET monthly_price=299900,annual_price=2999000,onboarding_fee=0,trial_days=0,recommended=false,public_visible=true,booking_commission_percent=0 WHERE code='enterprise';

COMMIT;
