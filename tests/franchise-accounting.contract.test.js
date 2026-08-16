const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const migration=fs.readFileSync('src/sql/20260816_FRANCHISE_ACCOUNTING_V6.sql','utf8');
const route=fs.readFileSync('src/routes/franchiseAccounting.ts','utf8');
const saas=fs.readFileSync('src/routes/saas.ts','utf8');
const bootstrap=fs.readFileSync('src/finance/ensureFinanceNav.ts','utf8');

test('official work-order invoice is the authoritative service revenue source',()=>{
  assert.ok(migration.includes("COALESCE(NEW.document_kind,'') <> 'tax_invoice'"));
  assert.ok(migration.includes('NEW.issued_at IS NULL'));
  assert.ok(migration.includes('NEW.work_order_id IS NULL'));
  assert.ok(migration.includes("'workorder_invoice',NEW.id::text"));
  assert.ok(migration.includes('ROUND(NEW.net_total::numeric,2)'));
  assert.ok(migration.includes("'gross_total',NEW.gross_total"));
  assert.ok(migration.includes("'vat_total',NEW.vat_total"));
});

test('franchise-generated finance documents cannot recursively become royalty revenue',()=>{
  assert.ok(migration.includes('NEW.franchise_settlement_id IS NOT NULL'));
  assert.ok(migration.includes('ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS franchise_settlement_id bigint'));
  assert.ok(route.includes('franchise_settlement_id,franchise_receivable_id'));
});

test('approved settlement posts exactly one tenant-scoped receivable',()=>{
  assert.ok(route.includes("['approved','paid'].includes"));
  assert.ok(route.includes('UNIQUE(tenant_id,settlement_id)')||migration.includes('UNIQUE(tenant_id,settlement_id)'));
  assert.ok(route.includes('ON CONFLICT(tenant_id,settlement_id) DO NOTHING'));
  assert.ok(route.includes('req.tenant!.id'));
  assert.ok(route.includes("event_type,actor_user_id,payload"));
});

test('partner billing settings synchronize into open receivable snapshots',()=>{
  assert.ok(route.includes("router.put('/members/:memberId/billing'"));
  assert.ok(route.includes("UPDATE franchise_receivables SET billing_legal_name"));
  assert.ok(route.includes("finance_invoice_id IS NULL AND status IN ('posted','paid')"));
  assert.ok(route.includes('vat_amount=CASE WHEN $10::numeric IS NULL THEN NULL ELSE round(net_amount*$10::numeric,2) END'));
  assert.ok(route.includes('gross_amount=CASE WHEN $10::numeric IS NULL THEN NULL ELSE round(net_amount*(1+$10::numeric),2) END'));
});

test('invoice draft requires explicit VAT configuration and complete billing snapshot',()=>{
  assert.ok(route.includes('FRANCHISE_VAT_RATE_REQUIRED'));
  assert.ok(route.includes('FRANCHISE_BILLING_INCOMPLETE'));
  assert.ok(route.includes("document_kind,invoice_type,nav_status,nav_validation_status"));
  assert.ok(route.includes("'internal_draft','NORMAL','not_submitted','not_validated'"));
  assert.ok(route.includes("'Franchise royalty díj'"));
  assert.ok(route.includes("'Franchise marketing hozzájárulás'"));
});

test('paid settlement synchronizes its accounting receivable status',()=>{
  assert.ok(migration.includes("IF NEW.status='paid'"));
  assert.ok(migration.includes("UPDATE franchise_receivables SET status='paid'"));
  assert.ok(migration.includes('trg_franchise_sync_receivable_paid'));
});

test('franchise accounting is mounted behind SaaS tenant context and bootstrapped at startup',()=>{
  assert.ok(saas.includes('franchiseAccountingRouter'));
  assert.ok(saas.includes('router.use("/franchise-accounting",franchiseAccountingRouter)'));
  assert.ok(saas.indexOf('router.use(requireAuth, requireTenantContext)')<saas.indexOf('router.use("/franchise-accounting",franchiseAccountingRouter)'));
  assert.ok(bootstrap.includes("'20260816_SAAS_CORE_V1.sql'"));
  assert.ok(bootstrap.includes("'20260816_FRANCHISE_FINANCE_V5.sql'"));
  assert.ok(bootstrap.includes("'20260816_FRANCHISE_ACCOUNTING_V6.sql'"));
});
