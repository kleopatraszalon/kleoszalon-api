CREATE TABLE IF NOT EXISTS saas_lifecycle_policy_config (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled boolean NOT NULL DEFAULT false,
  trial_warning_days integer NOT NULL DEFAULT 3 CHECK (trial_warning_days BETWEEN 1 AND 30),
  trial_grace_days integer NOT NULL DEFAULT 3 CHECK (trial_grace_days BETWEEN 0 AND 30),
  notify_on_warning boolean NOT NULL DEFAULT true,
  notify_on_grace boolean NOT NULL DEFAULT true,
  notify_on_suspend boolean NOT NULL DEFAULT true,
  auto_apply_suspend boolean NOT NULL DEFAULT false,
  updated_by text NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO saas_lifecycle_policy_config(id) VALUES(1) ON CONFLICT(id) DO NOTHING;

CREATE TABLE IF NOT EXISTS saas_lifecycle_notification_queue (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id bigint NULL REFERENCES subscriptions(id) ON DELETE SET NULL,
  notification_type text NOT NULL CHECK (notification_type IN ('trial_warning','trial_grace','subscription_suspend')),
  channel text NOT NULL DEFAULT 'email' CHECK (channel IN ('email','in_app')),
  recipient_email text NULL,
  subject text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','cancelled')),
  dedupe_key text NOT NULL UNIQUE,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz NULL,
  last_error text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_saas_lifecycle_notification_pending ON saas_lifecycle_notification_queue(status,next_attempt_at,created_at);
CREATE INDEX IF NOT EXISTS idx_saas_lifecycle_notification_tenant ON saas_lifecycle_notification_queue(tenant_id,created_at DESC);
