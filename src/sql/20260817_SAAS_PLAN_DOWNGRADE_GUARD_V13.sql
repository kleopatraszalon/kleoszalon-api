BEGIN;

CREATE OR REPLACE FUNCTION saas_guard_subscription_plan_capacity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_max_locations integer;
  v_max_users integer;
  v_location_count integer;
  v_user_count integer;
  v_plan_code text;
BEGIN
  IF TG_OP='UPDATE' AND NEW.plan_id IS NOT DISTINCT FROM OLD.plan_id THEN
    RETURN NEW;
  END IF;

  SELECT code,max_locations,max_users
    INTO v_plan_code,v_max_locations,v_max_users
    FROM subscription_plans
   WHERE id=NEW.plan_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SAAS_PLAN_NOT_FOUND' USING ERRCODE='P0001';
  END IF;

  -- Internal/root capacity remains intentionally unlimited.
  IF v_plan_code='internal' THEN
    RETURN NEW;
  END IF;

  SELECT count(*)::int
    INTO v_location_count
    FROM locations
   WHERE tenant_id=NEW.tenant_id
     AND is_active=true;

  SELECT count(*)::int
    INTO v_user_count
    FROM tenant_users
   WHERE tenant_id=NEW.tenant_id
     AND active=true;

  IF v_max_locations IS NOT NULL AND v_max_locations>=0 AND v_location_count>v_max_locations THEN
    RAISE EXCEPTION 'SAAS_PLAN_LIMIT_BELOW_USAGE: locations % > limit % for plan %',v_location_count,v_max_locations,v_plan_code
      USING ERRCODE='P0001', HINT='Choose a plan whose max_locations covers current active locations.';
  END IF;

  IF v_max_users IS NOT NULL AND v_max_users>=0 AND v_user_count>v_max_users THEN
    RAISE EXCEPTION 'SAAS_PLAN_LIMIT_BELOW_USAGE: users % > limit % for plan %',v_user_count,v_max_users,v_plan_code
      USING ERRCODE='P0001', HINT='Choose a plan whose max_users covers current active tenant users.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS subscriptions_plan_capacity_guard_trg ON subscriptions;
CREATE TRIGGER subscriptions_plan_capacity_guard_trg
BEFORE INSERT OR UPDATE OF plan_id ON subscriptions
FOR EACH ROW
EXECUTE FUNCTION saas_guard_subscription_plan_capacity();

COMMIT;
