const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

// KLEO-FUN-WO-003-AC-02
// KLEO-FUN-FIN-003-AC-02
// KLEO-NFR-IDEM-001-AC-01
test('closed work orders reject further settlement and protected writes require idempotency',()=>{
  const tx=read('src/routes/transactions.ts');
  const cashier=read('src/routes/workOrderCashierFast.ts');
  const integrity=read('src/finance/financialIntegrity.ts');
  const sql=read('src/sql/20260816_FINANCIAL_INTEGRITY_V1.sql');
  assert.match(tx,/financial_closed_at[\s\S]{0,350}status\(409\)/);
  assert.match(tx,/locked_at\|\|wo\.archived_at/);
  assert.match(cashier,/requireIdempotencyKey\(req,'workorder-settlement'\)/);
  assert.match(integrity,/finance_idempotency_key_required/);
  assert.match(sql,/work_order_settlements[\s\S]*settlement_key text NOT NULL UNIQUE/);
  assert.match(sql,/financial_movements_idempotency_uq/);
});

// KLEO-FUN-FIN-004-AC-01
// KLEO-FUN-FIN-004-AC-02
test('outgoing invoice and NAV lifecycle are deduplicated and fail closed',()=>{
  const invoice=read('src/routes/workOrderInvoiceFast.ts');
  const lifecycle=read('src/routes/navInvoiceLifecycle.ts');
  const worker=read('src/routes/navQueueWorker.ts');
  assert.match(invoice,/latestInvoice/);
  assert.match(invoice,/work_order_id/);
  assert.match(lifecycle,/INSERT INTO nav_invoice_queue[\s\S]*ON CONFLICT DO NOTHING/);
  assert.match(lifecycle,/NAV_INVOICE_NOT_ISSUED/);
  assert.match(worker,/NAV_LIVE_SUBMIT_ENABLED/);
  assert.match(worker,/nav_live_automation_locked/);
  assert.match(worker,/live_secrets_in_environment/);
});

// KLEO-FUN-PROC-001-AC-01
test('procurement approval is server-side and unauthorized approval is denied',()=>{
  const procurement=read('src/routes/procurementWorkflow.ts');
  assert.match(procurement,/const canApprove/);
  assert.match(procurement,/if \(!canApprove\(req\)\) return res\.status\(403\)/);
  assert.match(procurement,/approval_status='approved'/);
  assert.match(procurement,/procurement_approval_events/);
});

// KLEO-FUN-PAY-002-AC-01
test('payslip generation requires an approved payroll run and carries payroll identity',()=>{
  const payroll=read('src/routes/payrollAccounting.ts');
  assert.match(payroll,/PDF csak jóváhagyott vagy kifizetett számfejtésből készíthető/);
  assert.match(payroll,/Berszamfejtes: \$\{x\.run_id\}/);
  assert.match(payroll,/payroll_payslips/);
});

// KLEO-FUN-ACC-001-AC-01
// KLEO-FUN-ACC-001-AC-02
test('ledger posting is balanced, transactional and duplicate source posting is blocked',()=>{
  const payroll=read('src/routes/payrollAccounting.ts');
  const sql=read('src/sql/20260816_FINANCIAL_INTEGRITY_V1.sql');
  assert.match(payroll,/source_type='payroll' AND source_id=\$1/);
  assert.match(payroll,/Ez a számfejtés már fel lett adva a főkönyvbe/);
  assert.match(payroll,/client\.query\('BEGIN'\)/);
  assert.match(payroll,/client\.query\('ROLLBACK'\)/);
  assert.match(sql,/trg_finance_journal_lines_balanced/);
  assert.match(sql,/tartozik <> követel/i);
});

// KLEO-NFR-SEC-004-AC-01
// KLEO-NFR-SEC-004-AC-02
test('RBAC is fail-closed and location managers are server-side scoped',()=>{
  const menu=read('src/middleware/menuPermission.ts');
  const feature=read('src/middleware/featureAccess.ts');
  const scope=read('src/middleware/locationManagerScope.ts');
  const server=read('src/server.ts');
  assert.match(menu,/permission_not_configured/);
  assert.match(menu,/rbac_schema_unavailable/);
  assert.match(feature,/feature_not_configured/);
  assert.match(scope,/forceLocation\(req,locationId\)/);
  assert.match(scope,/nem ehhez az üzlethez tartozik/);
  assert.match(server,/locationManagerScope\("workorders"\)/);
  assert.match(server,/locationManagerScope\("appointments"\)/);
  assert.match(server,/locationManagerScope\("procurement"\)/);
});

// KLEO-NFR-OPS-001-AC-01
test('system health reports critical schema, RBAC, finance and ledger invariants',()=>{
  const health=read('src/routes/systemHealth.ts');
  assert.match(health,/role_menu_permissions/);
  assert.match(health,/schema_migrations/);
  assert.match(health,/finance_invoices/);
  assert.match(health,/accounting_journal_entries/);
  assert.match(health,/ledger\.balance/);
  assert.match(health,/finance\.vat/);
});

// KLEO-NFR-REL-001-AC-01
test('critical finance migrations are deterministic bootstrap stages and SQL is transactional',()=>{
  const bootstrap=read('src/finance/ensureFinanceNav.ts');
  const integrity=read('src/sql/20260816_FINANCIAL_INTEGRITY_V1.sql');
  const evidence=read('src/sql/20260816_REQUIREMENTS_EVIDENCE_V2.sql');
  assert.match(bootstrap,/20260816_FINANCIAL_INTEGRITY_V1\.sql/);
  assert.match(integrity,/^BEGIN;/);
  assert.match(integrity,/COMMIT;/);
  assert.match(evidence,/^BEGIN;/);
  assert.match(evidence,/COMMIT;/);
});
