'use strict';
module.exports={schema_version:'1.0.0',entries:[
 {criterion_id:'KLEO-FUN-COMM-001-AC-01',test_ref:'tests/requirements-critical-automation-v19.contract.test.js',execution_type:'integration'},
 {criterion_id:'KLEO-FUN-COMM-001-AC-02',test_ref:'tests/requirements-critical-automation-v19.contract.test.js',execution_type:'integration'},
 {criterion_id:'KLEO-FUN-FIN-003-AC-01',test_ref:'tests/requirements-critical-automation-v19.contract.test.js',execution_type:'integration'},
 {criterion_id:'KLEO-FUN-FIN-003-AC-02',test_ref:'tests/requirements-critical-automation-v19.contract.test.js',execution_type:'integration'},
 {criterion_id:'KLEO-NFR-BCK-001-AC-01',test_ref:'tests/backup_restore_rehearsal.mjs',execution_type:'resilience',evidence_mode:'external-workflow',workflow_ref:'.github/workflows/backup-restore-evidence.yml'},
 {criterion_id:'KLEO-NFR-BCK-001-AC-02',test_ref:'tests/backup_restore_rehearsal.mjs',execution_type:'resilience',evidence_mode:'external-workflow',workflow_ref:'.github/workflows/backup-restore-evidence.yml'}
]};
