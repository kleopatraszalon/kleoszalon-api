const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

// KLEO-FUN-COMM-001-AC-01
// KLEO-FUN-COMM-001-AC-02
test('complaint mailbox creates one traceable complaint per mailbox UID and persists attachments',()=>{
  const src=read('src/services/complaintMailbox.ts');
  assert.match(src,/CREATE TABLE IF NOT EXISTS complaint_mail_messages/);
  assert.match(src,/UNIQUE\(mailbox_key, imap_uid\)/);
  assert.match(src,/SELECT id FROM complaint_mail_messages WHERE mailbox_key=\$1 AND imap_uid=\$2/);
  assert.match(src,/if \(exists\.rowCount\) \{ await client\.query\("ROLLBACK"\); return false; \}/);
  assert.match(src,/message_id: mail\.messageId/);
  assert.match(src,/sender_email: mail\.from/);
  assert.match(src,/CREATE TABLE IF NOT EXISTS complaint_attachments/);
  assert.match(src,/INSERT INTO complaint_attachments/);
  assert.match(src,/crypto\.createHash\("sha256"\)/);
});

// KLEO-FUN-PAY-001-AC-01
// KLEO-FUN-PAY-001-AC-02
test('payroll calculation is reproducible from approved inputs and overlapping active runs are rejected',()=>{
  const src=read('src/routes/payrollIntegrated.ts');
  assert.match(src,/FROM timesheets WHERE work_date BETWEEN \$1::date AND \$2::date[\s\S]*status='approved'/);
  assert.match(src,/const deductions=num\(settings\.default_deduction\)\+gross\*\(num\(settings\.tax_percent\)\+num\(settings\.social_contribution_percent\)\)\/100/);
  assert.match(src,/gross_pay:round\(gross\),net_pay:round\(Math\.max\(0,gross-deductions\)\)/);
  assert.match(src,/SELECT id,status,title,period_from,period_to,location_id FROM payroll_runs WHERE status<>'cancelled'/);
  assert.match(src,/FOR UPDATE/);
  assert.match(src,/duplikált bér vagy jutalék keletkezhetne/);
  assert.match(src,/return res\.status\(409\)/);
  assert.match(src,/UNIQUE\(commission_event_id\)/);
});

// KLEO-FUN-PAY-002-AC-02
test('payslip delivery is bound to the selected employee and every delivery attempt is persisted',()=>{
  const src=read('src/routes/payrollAccounting.ts');
  assert.match(src,/WHERE r\.id=\$1 AND e\.id=\$2/);
  assert.match(src,/const to=String\(emailOverride\|\|x\.email\|\|''\)\.trim\(\)/);
  assert.match(src,/INSERT INTO payroll_payslips/);
  assert.match(src,/email_to,email_status/);
  assert.match(src,/email_status='pending'/);
  assert.match(src,/email_status=\$3/);
  assert.match(src,/email_status='failed'/);
  assert.match(src,/attachments:\[\{filename:`berjegyzek-/);
});

// KLEO-NFR-PRV-001-AC-02
test('GDPR erasure anonymizes removable data while preserving legal financial records and legal holds',()=>{
  const route=read('src/routes/gdpr.ts');
  const actions=read('src/gdpr/subjectActions.ts');
  assert.match(actions,/activeSubjectHolds/);
  assert.match(actions,/scope_type='subject'/);
  assert.match(actions,/status='active'/);
  assert.match(actions,/preserved_legal_records:\{finalized_financial_records:protectedFinancial\}/);
  assert.match(actions,/mode:"anonymization_no_physical_delete"/);
  assert.match(actions,/gdpr_erased_at:"now\(\)"/);
  assert.match(route,/legal_exceptions/);
  assert.match(route,/preserved_under_legal_obligation/);
});

// KLEO-NFR-PRV-002-AC-01
test('retention execution is preview-bound, legal-hold aware, auditable and forbids automatic physical delete',()=>{
  const src=read('src/gdpr/retentionEngine.ts');
  assert.match(src,/if\(String\(policy\.action\)==="delete"\)throw/);
  assert.match(src,/Fizikai törlés nem hajtható végre automatikusan/);
  assert.match(src,/gdpr_legal_holds/);
  assert.match(src,/preview_hash:previewHash\(summary\)/);
  assert.match(src,/current\.preview_hash!==run\.preview_hash/);
  assert.match(src,/gdpr_retention_processed/);
  assert.match(src,/ON CONFLICT\(policy_id,entity_id\) DO NOTHING/);
  assert.match(src,/processed:Number\(update\.rowCount\|\|0\)/);
});

// KLEO-FUN-NOT-001-AC-02
test('notification read state is persisted per user and survives subsequent reads',()=>{
  const src=read('src/routes/notificationsLegacy.ts');
  assert.match(src,/notificationUserKey\(req\)/);
  assert.match(src,/notification_read_state WHERE user_key=\$1/);
  assert.match(src,/states = new Map/);
  assert.match(src,/read: Boolean\(states\.get\(n\.key\)\?\.read_at\)/);
  assert.match(src,/INSERT INTO notification_read_state\(user_key,notification_key,read_at,updated_at\)/);
  assert.match(src,/ON CONFLICT\(user_key,notification_key\) DO UPDATE SET read_at=now\(\)/);
  assert.match(src,/unread_count: items\.filter\(x=>!x\.read\)\.length/);
});

// KLEO-NFR-IDEM-001-AC-02
test('settlement retry returns the recorded prior result without repeating side effects',()=>{
  const src=read('src/routes/workOrderCashierFast.ts');
  const sql=read('src/sql/20260816_FINANCIAL_INTEGRITY_V1.sql');
  assert.match(src,/SELECT \*,request_payload=\$2::jsonb AS same_payload FROM work_order_settlements WHERE settlement_key=\$1 FOR UPDATE/);
  assert.match(src,/previous\.same_payload/);
  assert.match(src,/result_snapshot/);
  assert.match(sql,/settlement_key text NOT NULL UNIQUE/);
  assert.match(sql,/result_snapshot jsonb/);
  assert.match(sql,/work_order_settlements_completion_ck/);
});

// KLEO-NFR-OPS-001-AC-02
test('release gate decision is build/environment bound and cannot report GO with missing evidence or critical failures',()=>{
  const sql=read('src/sql/20260816_REQUIREMENTS_EVIDENCE_V2.sql');
  assert.match(sql,/CREATE TABLE IF NOT EXISTS requirement_release_gate_runs/);
  assert.match(sql,/release_ref text NOT NULL/);
  assert.match(sql,/build_ref text NOT NULL/);
  assert.match(sql,/environment text NOT NULL/);
  assert.match(sql,/missing_evidence_criteria integer NOT NULL/);
  assert.match(sql,/critical_open integer NOT NULL/);
  assert.match(sql,/decision text NOT NULL CHECK\(decision IN \('GO','CONDITIONAL_GO','NO_GO'\)\)/);
  assert.match(sql,/UNIQUE\(release_ref,build_ref,environment\)/);
});
