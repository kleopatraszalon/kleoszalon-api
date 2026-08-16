BEGIN;

INSERT INTO uat_test_cases(code,module_key,title,description,expected_result,route,order_index,critical,active,requirement_id,requirement_text,acceptance_criteria,source_reference,owner_role,priority,verification_method,catalog_requirement_id,acceptance_criteria_id,external_test_case_id,evidence_required,requirement_lifecycle_status)
VALUES
('UAT-DAYCLOSE-001','cashier','Napzárás csak lezárt vendégekkel','Nyitott munkalap mellett a napzárás blokkolása, majd minden munkalap lezárása után egyetlen zárási rekord létrehozása.','Nyitott munkalapnál nincs zárás; lezárt üzleti napnál pontosan egy zárási rekord készül végrehajtóval és időbélyeggel.','/cashier',145,true,true,'KLEO-GEN-OPS-001','A nap csak minden vendég és munkafolyamat lezárása után zárható.','KLEO-GEN-OPS-001-AC-01/02','SRS v2 / 41. oldal','Product Owner','P0','AUTOMATED+UAT','KLEO-GEN-OPS-001','KLEO-GEN-OPS-001-AC-01','TC-KLEO-GEN-OPS-001-AC-01',true,'approved')
ON CONFLICT(code) DO UPDATE SET
  module_key=EXCLUDED.module_key,title=EXCLUDED.title,description=EXCLUDED.description,expected_result=EXCLUDED.expected_result,
  route=EXCLUDED.route,order_index=EXCLUDED.order_index,critical=true,active=true,requirement_id=EXCLUDED.requirement_id,
  requirement_text=EXCLUDED.requirement_text,acceptance_criteria=EXCLUDED.acceptance_criteria,source_reference=EXCLUDED.source_reference,
  owner_role=EXCLUDED.owner_role,priority=EXCLUDED.priority,verification_method=EXCLUDED.verification_method,
  catalog_requirement_id=EXCLUDED.catalog_requirement_id,acceptance_criteria_id=EXCLUDED.acceptance_criteria_id,
  external_test_case_id=EXCLUDED.external_test_case_id,evidence_required=true,requirement_lifecycle_status='approved',updated_at=now();

COMMIT;
