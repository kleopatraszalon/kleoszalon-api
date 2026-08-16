'use strict';
module.exports={schema_version:'1.1.0',entries:[
 {criterion_id:'KLEO-FUN-FIN-003-AC-01',test_ref:'tests/requirements-critical-automation-v19.contract.test.js',execution_type:'integration'},
 {criterion_id:'KLEO-FUN-CRM-001-AC-01',test_ref:'tests/crm_loyalty_v19.integration.sql',execution_type:'integration',evidence_mode:'external-workflow',workflow_ref:'.github/workflows/crm-loyalty-v19.yml'},
 {criterion_id:'KLEO-FUN-CRM-001-AC-02',test_ref:'tests/crm_loyalty_v19.integration.sql',execution_type:'integration',evidence_mode:'external-workflow',workflow_ref:'.github/workflows/crm-loyalty-v19.yml'},
 {criterion_id:'KLEO-FUN-LOY-001-AC-01',test_ref:'tests/crm_loyalty_v19.integration.sql',execution_type:'integration',evidence_mode:'external-workflow',workflow_ref:'.github/workflows/crm-loyalty-v19.yml'},
 {criterion_id:'KLEO-FUN-LOY-001-AC-02',test_ref:'tests/crm_loyalty_v19.integration.sql',execution_type:'integration',evidence_mode:'external-workflow',workflow_ref:'.github/workflows/crm-loyalty-v19.yml'}
]};
