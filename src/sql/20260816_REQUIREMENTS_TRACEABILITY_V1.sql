BEGIN;

ALTER TABLE uat_test_cases ADD COLUMN IF NOT EXISTS requirement_id text;
ALTER TABLE uat_test_cases ADD COLUMN IF NOT EXISTS requirement_text text;
ALTER TABLE uat_test_cases ADD COLUMN IF NOT EXISTS acceptance_criteria text;
ALTER TABLE uat_test_cases ADD COLUMN IF NOT EXISTS source_reference text;
ALTER TABLE uat_test_cases ADD COLUMN IF NOT EXISTS owner_role text;
ALTER TABLE uat_test_cases ADD COLUMN IF NOT EXISTS priority text;
ALTER TABLE uat_test_cases ADD COLUMN IF NOT EXISTS verification_method text;

UPDATE uat_test_cases
SET requirement_id=COALESCE(NULLIF(requirement_id,''),'REQ-'||regexp_replace(regexp_replace(upper(code),'^UAT-',''),'[^A-Z0-9]+','-','g')),
    requirement_text=COALESCE(NULLIF(requirement_text,''),NULLIF(description,''),title||' működése a VIR-ben igazolható legyen.'),
    acceptance_criteria=COALESCE(NULLIF(acceptance_criteria,''),NULLIF(expected_result,''),'Az elvárt üzleti eredmény hiba nélkül, reprodukálhatóan teljesül.'),
    priority=COALESCE(NULLIF(priority,''),CASE WHEN critical THEN 'P0' WHEN code ILIKE '%FIN%' OR code ILIKE '%RBAC%' OR code ILIKE '%GDPR%' THEN 'P1' ELSE 'P2' END),
    verification_method=COALESCE(NULLIF(verification_method,''),CASE WHEN code ILIKE '%SYS%' OR code ILIKE '%RBAC%' OR code ILIKE '%FIN%' OR code ILIKE '%ACC%' THEN 'AUTOMATED+UAT' ELSE 'UAT' END),
    owner_role=COALESCE(NULLIF(owner_role,''),'management')
WHERE active=true;

CREATE UNIQUE INDEX IF NOT EXISTS ux_uat_test_cases_requirement_id ON uat_test_cases(requirement_id) WHERE requirement_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_uat_test_cases_priority ON uat_test_cases(priority) WHERE active=true;

DO $$
DECLARE settings_id bigint;
BEGIN
 SELECT id INTO settings_id FROM menus WHERE code='settings' LIMIT 1;
 IF settings_id IS NOT NULL THEN
  INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
  VALUES('settings.requirements','Követelmények és tesztelés','FileCheck2','/admin/uat',86,settings_id,NULL,true)
  ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,icon=EXCLUDED.icon,route=EXCLUDED.route,order_index=EXCLUDED.order_index,parent_id=EXCLUDED.parent_id,is_active=true;
 END IF;
END $$;

INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type)
SELECT r.role_key,m.id,true,false,false,false,false,true,false,false,'all_locations'
FROM (VALUES('admin'),('manager')) r(role_key)
JOIN menus m ON m.code='settings.requirements'
ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=true,can_export=true,scope_type='all_locations';

COMMIT;
