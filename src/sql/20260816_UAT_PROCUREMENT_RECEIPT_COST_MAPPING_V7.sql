BEGIN;

INSERT INTO uat_test_cases(code,module_key,title,description,expected_result,route,order_index,critical,active,requirement_id,requirement_text,acceptance_criteria,source_reference,owner_role,priority,verification_method,catalog_requirement_id,acceptance_criteria_id,external_test_case_id,evidence_required,requirement_lifecycle_status)
VALUES
('UAT-INV-RECEIPT-COST-001','inventory','Bevételezési költség reprodukálhatósága','A nettó tételár, adókulcs, járulékos költség és bizonylatszám megőrzése, valamint a bruttó és landed egységköltség reprodukálhatóságának ellenőrzése.','A tárolt nettó, adó, bruttó, járulékos és landed értékek a rögzített komponensekből legfeljebb 0,01 eltéréssel visszaszámolhatók, és a kapcsolt bizonylatszám megmarad.','/inventory/purchase-orders',146,true,true,'KLEO-FUN-INV-002','A bevételezés készletet növel és a beszerzési költséget a kapcsolt bizonylattal együtt megőrzi.','KLEO-FUN-INV-002-AC-02','SRS v2 / 29. oldal','Inventory Owner','P0','AUTOMATED+UAT','KLEO-FUN-INV-002','KLEO-FUN-INV-002-AC-02','TC-KLEO-FUN-INV-002-AC-02',true,'approved')
ON CONFLICT(code) DO UPDATE SET
  module_key=EXCLUDED.module_key,title=EXCLUDED.title,description=EXCLUDED.description,expected_result=EXCLUDED.expected_result,
  route=EXCLUDED.route,order_index=EXCLUDED.order_index,critical=true,active=true,requirement_id=EXCLUDED.requirement_id,
  requirement_text=EXCLUDED.requirement_text,acceptance_criteria=EXCLUDED.acceptance_criteria,source_reference=EXCLUDED.source_reference,
  owner_role=EXCLUDED.owner_role,priority=EXCLUDED.priority,verification_method=EXCLUDED.verification_method,
  catalog_requirement_id=EXCLUDED.catalog_requirement_id,acceptance_criteria_id=EXCLUDED.acceptance_criteria_id,
  external_test_case_id=EXCLUDED.external_test_case_id,evidence_required=true,requirement_lifecycle_status='approved',updated_at=now();

COMMIT;
