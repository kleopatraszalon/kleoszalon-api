const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const v1=read('src/sql/20260826_LEGAL_ENTITIES_MULTI_COMPANY_V1.sql');
const v2=read('src/sql/20260826_LEGAL_ENTITIES_WORKORDER_GUARD_V2.sql');
const v3=read('src/sql/20260826_LEGAL_ENTITIES_ACCOUNTING_DEFAULTS_V3.sql');
const v4=read('src/sql/20260826_LEGAL_ENTITIES_PENDING_SELECTION_V4.sql');
const v5=read('src/sql/20260826_LEGAL_ENTITIES_OPERATIONAL_DRAFT_V5.sql');
const ensure=read('src/finance/ensureFinanceNav.ts');
const entities=read('src/routes/legalEntities.ts');
const workorder=read('src/routes/workOrderLegalEntity.ts');
const receiptRouter=read('src/routes/receiptCompliance.ts');
const lifecycle=read('src/routes/receiptCompanyLifecycleV2.ts');
const receiptDaily=read('src/routes/receiptDocumentsCompliance.ts');

test('legal entity schema separates company, salon and accounting dimensions',()=>{
  assert.match(v1,/CREATE TABLE IF NOT EXISTS legal_entities/);
  assert.match(v1,/CREATE TABLE IF NOT EXISTS legal_entity_locations/);
  assert.match(v1,/ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS legal_entity_id/);
  assert.match(v1,/ALTER TABLE work_order_payments ADD COLUMN IF NOT EXISTS legal_entity_id/);
  assert.match(v1,/ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS legal_entity_id/);
  assert.match(v1,/ALTER TABLE financial_movements ADD COLUMN IF NOT EXISTS legal_entity_id/);
  assert.match(v1,/legal_entities_hu_tax_number_chk/);
  assert.match(v1,/legal_entities_company_id_chk/);
  assert.match(v1,/legal_entity_locations_one_default_uq/);
});

test('legal entity migration tolerates legacy work-order id type drift',()=>{
  assert.match(v1,/w\.id::text=p\.work_order_id::text/);
  assert.match(v1,/w\.id::text=i\.work_order_id::text/);
  assert.match(v1,/w\.id::text=m\.work_order_id::text/);
  assert.match(v1,/id::text=NEW\.work_order_id::text/);
  assert.match(v5,/id::text=NEW\.work_order_id::text/);
  assert.doesNotMatch(v1,/w\.id=m\.work_order_id/);
});

test('shared legal entity trigger never dereferences table-specific fields directly',()=>{
  for(const migration of [v1,v5]){
    assert.match(migration,/reversal_id_text:=to_jsonb\(NEW\)->>'reversal_of_id'/);
    assert.match(migration,/id::text=reversal_id_text/);
    assert.doesNotMatch(migration,/TG_TABLE_NAME='financial_movements' AND NEW\.reversal_of_id/);
  }
  assert.match(v5,/location_value:=to_jsonb\(NEW\)->>'location_id'/);
});

test('all multi-company migrations run through finance bootstrap',()=>{
  for(const version of ['MULTI_COMPANY_V1','WORKORDER_GUARD_V2','ACCOUNTING_DEFAULTS_V3','PENDING_SELECTION_V4']){
    assert.match(ensure,new RegExp(`20260826_LEGAL_ENTITIES_${version}\\.sql`));
  }
});

test('work order company is immutable after financial evidence exists',()=>{
  assert.match(v2,/Pénzügyileg lezárt vagy kifizetett munkalap cége nem módosítható/);
  assert.match(v2,/EXISTS\(SELECT 1 FROM work_order_payments/);
  assert.match(v2,/EXISTS\(SELECT 1 FROM finance_invoices/);
  assert.match(v2,/vir_receipts/);
  assert.match(v2,/BEFORE UPDATE OF legal_entity_id/);
});

test('multi-company salon requires an explicit one-time company selection',()=>{
  assert.match(v4,/CREATE TABLE IF NOT EXISTS legal_entity_workorder_selections/);
  assert.match(v4,/active_count>1/);
  assert.match(v4,/több cég működik/);
  assert.match(v4,/DELETE FROM legal_entity_workorder_selections WHERE actor_key=NEW\.created_by/);
  assert.match(workorder,/router\.post\('\/pending-selection'/);
  assert.match(workorder,/ON CONFLICT\(actor_key\) DO UPDATE/);
  assert.match(workorder,/A kiválasztott cég nincs hozzárendelve a saját szalonhoz/);
});

test('company master data and per-company accounting APIs are present',()=>{
  assert.match(entities,/router\.post\('\/',requireRoles\('admin'\)/);
  assert.match(entities,/router\.put\('\/:id',requireRoles\('admin'\)/);
  assert.match(entities,/accounting\/summary/);
  assert.match(entities,/legal_entity_id=\$1::uuid/);
  assert.match(entities,/accounting_ledger_code/);
  assert.match(entities,/default_for_location_ids/);
});

test('receipt lifecycle V2 is first and company-aware',()=>{
  const lifecycleIndex=receiptRouter.indexOf('router.use(receiptCompanyLifecycleV2)');
  const legacyIndex=receiptRouter.indexOf('router.use(receiptIssuance)');
  assert.ok(lifecycleIndex>=0&&legacyIndex>lifecycleIndex,'V2 lifecycle must shadow legacy issue/void routes');
  assert.match(lifecycle,/legal_entity_id/);
  assert.match(lifecycle,/entity\.id.*entity\.prefix/);
});

test('receipt issue preserves product and service VAT and never mutates locked work order headers',()=>{
  assert.match(lifecycle,/LEFT JOIN products p/);
  assert.match(lifecycle,/LEFT JOIN services s/);
  assert.match(lifecycle,/product\.vat_rate \?\? service\.vat_rate/);
  assert.match(lifecycle,/Boolean\(j\.locked_at \|\| j\.archived_at\)/);
  assert.match(lifecycle,/type === "WORK_ORDER" && !source\.locked/);
});

test('receipt void uses audited refund, ledger and cash-register models',()=>{
  assert.match(lifecycle,/work_order_payment_refunds/);
  assert.match(lifecycle,/INSERT INTO financial_movements\(location_id,legal_entity_id/);
  assert.match(lifecycle,/reference_type,reference_id/);
  assert.match(lifecycle,/cash_register_movements/);
  assert.match(lifecycle,/finance_integrity_events/);
  assert.match(lifecycle,/locked_work_order_header_unchanged/);
});

test('payments invoices movements and receipts inherit the work order company',()=>{
  assert.match(v3,/trg_work_order_payments_legal_entity/);
  assert.match(v3,/trg_finance_invoices_legal_entity/);
  assert.match(v3,/trg_financial_movements_legal_entity/);
  assert.match(v3,/trg_vir_receipts_legal_entity/);
  assert.match(receiptRouter,/legalEntitiesRouter/);
  assert.match(receiptRouter,/workOrderLegalEntityRouter/);
});

test('NAV receipt batches are separated by legal entity and actual document issue date',()=>{
  assert.match(receiptDaily,/FROM vir_receipts r/);
  assert.match(receiptDaily,/legal_entity_id/);
  assert.match(receiptDaily,/legal_entity_name/);
  assert.match(receiptDaily,/issuer_tax_number/);
  assert.match(receiptDaily,/batchFor\(r\.legal_entity_id\)/);
  assert.match(receiptDaily,/document_type === "VOID"/);
});
