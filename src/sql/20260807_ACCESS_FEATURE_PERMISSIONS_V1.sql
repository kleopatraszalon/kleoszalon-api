BEGIN;

CREATE TABLE IF NOT EXISTS role_feature_permissions (
  role_key text NOT NULL,
  feature_key text NOT NULL,
  can_use boolean NOT NULL DEFAULT false,
  scope_type text NOT NULL DEFAULT 'own_location',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_key, feature_key)
);

CREATE INDEX IF NOT EXISTS role_feature_permissions_feature_idx
  ON role_feature_permissions (feature_key, role_key);

COMMIT;
