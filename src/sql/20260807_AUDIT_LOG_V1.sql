BEGIN;

CREATE TABLE IF NOT EXISTS system_audit_log (
  id bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_key text,
  actor_name text,
  location_id text,
  module_key text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  action text NOT NULL,
  severity text NOT NULL DEFAULT 'info',
  summary text,
  before_data jsonb,
  after_data jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS system_audit_log_time_idx ON system_audit_log(occurred_at DESC);
CREATE INDEX IF NOT EXISTS system_audit_log_module_idx ON system_audit_log(module_key, occurred_at DESC);
CREATE INDEX IF NOT EXISTS system_audit_log_actor_idx ON system_audit_log(actor_key, occurred_at DESC);
CREATE INDEX IF NOT EXISTS system_audit_log_entity_idx ON system_audit_log(entity_type, entity_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS system_audit_log_location_idx ON system_audit_log(location_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION kleo_audit_row_change() RETURNS trigger AS $$
DECLARE
  oldj jsonb := CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  newj jsonb := CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;
  rowj jsonb := COALESCE(newj, oldj, '{}'::jsonb);
  entity text := COALESCE(rowj->>'id', rowj->>'role_key', rowj->>'user_key', rowj->>'product_id', rowj->>'work_order_id');
  actor text := COALESCE(current_setting('app.kleo_user', true), rowj->>'updated_by', rowj->>'financial_closed_by', rowj->>'closed_by', rowj->>'created_by');
  loc text := COALESCE(rowj->>'location_id', rowj->>'last_location_id');
  module text := CASE
    WHEN TG_TABLE_NAME IN ('work_orders','work_order_payments','cash_register_closings') THEN 'finance'
    WHEN TG_TABLE_NAME IN ('product_stock_balances','product_stock_movements') THEN 'inventory'
    WHEN TG_TABLE_NAME IN ('employees','employment_contracts') THEN 'hr'
    WHEN TG_TABLE_NAME IN ('role_feature_permissions','dashboard_settings') THEN 'administration'
    ELSE 'system' END;
BEGIN
  INSERT INTO system_audit_log(actor_key,location_id,module_key,entity_type,entity_id,action,severity,summary,before_data,after_data,metadata)
  VALUES(actor,loc,module,TG_TABLE_NAME,entity,lower(TG_OP),'info',TG_TABLE_NAME||' '||lower(TG_OP),oldj,newj,jsonb_build_object('source','db_trigger'));
  RETURN COALESCE(NEW,OLD);
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['work_orders','work_order_payments','cash_register_closings','product_stock_balances','product_stock_movements','employees','employment_contracts','role_feature_permissions','dashboard_settings']
  LOOP
    IF to_regclass('public.'||t) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS kleo_audit_%I ON %I', t, t);
      EXECUTE format('CREATE TRIGGER kleo_audit_%I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION kleo_audit_row_change()', t, t);
    END IF;
  END LOOP;
END $$;

COMMIT;
