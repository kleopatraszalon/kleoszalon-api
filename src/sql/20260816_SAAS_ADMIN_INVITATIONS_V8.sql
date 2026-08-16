BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS tenant_admin_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','accepted','revoked','expired')),
  expires_at timestamptz NOT NULL,
  invited_by text,
  accepted_at timestamptz,
  accepted_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tenant_admin_invitations_tenant_idx
  ON tenant_admin_invitations(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tenant_admin_invitations_pending_idx
  ON tenant_admin_invitations(tenant_id, lower(email), expires_at)
  WHERE status='pending';

COMMIT;
