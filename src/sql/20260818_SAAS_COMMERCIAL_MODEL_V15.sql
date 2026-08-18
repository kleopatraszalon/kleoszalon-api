BEGIN;

-- VIR SaaS commercial model v15
-- Public list prices are NET HUF amounts. Kleopatra remains on the internal plan.

ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS annual_price numeric(14,2);
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS onboarding_fee numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS trial_days integer NOT NULL DEFAULT 0;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS public_visible boolean NOT NULL DEFAULT false;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS recommended boolean NOT NULL DEFAULT false;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 100;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS booking_commission_percent numeric(8,4) NOT NULL DEFAULT 0;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS extra_location_price numeric(14,2);
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS ai_plus_price numeric(14,2);
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS white_label_price numeric(14,2);
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS branded_app_price numeric(14,2);

UPDATE subscription_plans
SET name='Internal', monthly_price=0, annual_price=0, onboarding_fee=0,
    max_locations=NULL, max_users=NULL, trial_days=0, public_visible=false,
    recommended=false, sort_order=0, booking_commission_percent=0,
    extra_location_price=NULL, ai_plus_price=NULL, white_label_price=NULL, branded_app_price=NULL,
    features='{"all_modules":true}'::jsonb
WHERE code='internal';

UPDATE subscription_plans
SET name='START', monthly_price=29900, annual_price=299000, onboarding_fee=49900,
    max_locations=1, max_users=5, trial_days=14, public_visible=true,
    recommended=false, sort_order=10, booking_commission_percent=0,
    extra_location_price=NULL, ai_plus_price=NULL, white_label_price=NULL, branded_app_price=NULL,
    features='{"booking":true,"crm":true,"staff":true,"basic_reports":true,"online_booking":true,"daily_actions":true,"notifications":true,"rbac":true}'::jsonb
WHERE code='start';

UPDATE subscription_plans
SET name='PRO', monthly_price=59900, annual_price=599000, onboarding_fee=99900,
    max_locations=1, max_users=15, trial_days=14, public_visible=true,
    recommended=true, sort_order=20, booking_commission_percent=0,
    extra_location_price=19900, ai_plus_price=9900, white_label_price=NULL, branded_app_price=NULL,
    features='{"booking":true,"crm":true,"staff":true,"hr":true,"payroll":true,"inventory":true,"finance":true,"marketing":true,"loyalty":true,"mobile_app":true,"advanced_reports":true,"ai":true,"automation":true,"rbac":true}'::jsonb
WHERE code='pro';

UPDATE subscription_plans
SET name='NETWORK / FRANCHISE', monthly_price=149900, annual_price=1499000, onboarding_fee=299000,
    max_locations=5, max_users=50, trial_days=0, public_visible=true,
    recommended=false, sort_order=30, booking_commission_percent=0,
    extra_location_price=19900, ai_plus_price=9900, white_label_price=NULL, branded_app_price=NULL,
    features='{"booking":true,"crm":true,"staff":true,"hr":true,"payroll":true,"inventory":true,"finance":true,"marketing":true,"loyalty":true,"mobile_app":true,"advanced_reports":true,"ai":true,"automation":true,"franchise":true,"royalty":true,"marketing_fee":true,"consolidation":true,"audit":true,"rbac":true}'::jsonb
WHERE code='franchise';

UPDATE subscription_plans
SET name='ENTERPRISE', monthly_price=299900, annual_price=2999000, onboarding_fee=0,
    max_locations=NULL, max_users=NULL, trial_days=0, public_visible=true,
    recommended=false, sort_order=40, booking_commission_percent=0,
    extra_location_price=NULL, ai_plus_price=9900, white_label_price=39900, branded_app_price=49900,
    features='{"all_modules":true,"white_label":true,"custom_domain":true,"api":true,"priority_support":true,"sla":true,"custom_integrations":true}'::jsonb
WHERE code='enterprise';

COMMIT;
