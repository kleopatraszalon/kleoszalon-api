BEGIN;

CREATE TABLE IF NOT EXISTS saas_plan_quota_events (
  id BIGSERIAL PRIMARY KEY,
  plan_id BIGINT NOT NULL REFERENCES subscription_plans(id) ON DELETE CASCADE,
  actor_user_id TEXT,
  old_limits JSONB NOT NULL DEFAULT '{}'::jsonb,
  new_limits JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION saas_enforce_resource_quota()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_tenant_id BIGINT;
  v_resource TEXT;
  v_limit INTEGER;
  v_used INTEGER;
BEGIN
  v_tenant_id := NEW.tenant_id;
  IF v_tenant_id IS NULL THEN RETURN NEW; END IF;

  IF TG_TABLE_NAME='locations' THEN
    IF COALESCE(NEW.is_active,true)=false THEN RETURN NEW; END IF;
    IF TG_OP='UPDATE' AND OLD.tenant_id IS NOT DISTINCT FROM NEW.tenant_id AND COALESCE(OLD.is_active,true)=true THEN RETURN NEW; END IF;
    v_resource := 'locations';
  ELSIF TG_TABLE_NAME='tenant_users' THEN
    IF COALESCE(NEW.active,true)=false THEN RETURN NEW; END IF;
    IF TG_OP='UPDATE' AND OLD.tenant_id IS NOT DISTINCT FROM NEW.tenant_id AND OLD.user_id IS NOT DISTINCT FROM NEW.user_id AND COALESCE(OLD.active,true)=true THEN RETURN NEW; END IF;
    v_resource := 'users';
  ELSE
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('saas_quota:'||v_resource||':'||v_tenant_id::text));

  SELECT CASE WHEN v_resource='locations' THEN sp.max_locations ELSE sp.max_users END
    INTO v_limit
    FROM subscriptions s
    JOIN subscription_plans sp ON sp.id=s.plan_id
   WHERE s.tenant_id=v_tenant_id
   ORDER BY CASE WHEN s.status IN ('trial','active','past_due','suspended') THEN 0 ELSE 1 END,s.created_at DESC
   LIMIT 1;

  IF v_limit IS NULL THEN RETURN NEW; END IF;

  IF v_resource='locations' THEN
    SELECT count(*)::int INTO v_used FROM locations WHERE tenant_id=v_tenant_id AND COALESCE(is_active,true)=true;
  ELSE
    SELECT count(*)::int INTO v_used FROM tenant_users WHERE tenant_id=v_tenant_id AND active=true;
  END IF;

  IF v_used >= v_limit THEN
    RAISE EXCEPTION 'SAAS_QUOTA_EXCEEDED:% used=% limit=%',v_resource,v_used,v_limit USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_saas_locations_quota ON locations;
CREATE TRIGGER trg_saas_locations_quota
BEFORE INSERT OR UPDATE OF tenant_id,is_active ON locations
FOR EACH ROW EXECUTE FUNCTION saas_enforce_resource_quota();

DROP TRIGGER IF EXISTS trg_saas_tenant_users_quota ON tenant_users;
CREATE TRIGGER trg_saas_tenant_users_quota
BEFORE INSERT OR UPDATE OF tenant_id,user_id,active ON tenant_users
FOR EACH ROW EXECUTE FUNCTION saas_enforce_resource_quota();

COMMIT;
