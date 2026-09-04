const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const sql=fs.readFileSync(path.join(root,'src/sql/20260826_LEGAL_ENTITIES_MULTI_COMPANY_V1.sql'),'utf8');
const archive=fs.readFileSync(path.join(root,'src/sql/20260808_WORK_ORDER_OFFICIAL_NUMBER_ARCHIVE_V1.sql'),'utf8');

test('legal entity runtime bootstrap never updates archived work-order headers',()=>{
  assert.match(archive,/CREATE TRIGGER trg_work_orders_lock_before_update BEFORE UPDATE ON work_orders/);
  assert.match(archive,/IF OLD\.locked_at IS NOT NULL THEN[\s\S]*ERRCODE='55000'/);
  assert.match(sql,/UPDATE work_orders w SET legal_entity_id=[\s\S]*WHERE w\.legal_entity_id IS NULL\s+AND w\.locked_at IS NULL\s+AND w\.archived_at IS NULL;/);
});

test('legal entity runtime bootstrap skips payment rows whose parent work-order is immutable',()=>{
  assert.match(archive,/CREATE TRIGGER trg_work_order_payments_immutable BEFORE INSERT OR UPDATE OR DELETE ON work_order_payments/);
  assert.match(sql,/UPDATE work_order_payments p SET legal_entity_id=[\s\S]*WHERE p\.legal_entity_id IS NULL\s+AND NOT EXISTS \([\s\S]*lw\.id::text=p\.work_order_id::text[\s\S]*lw\.locked_at IS NOT NULL OR lw\.archived_at IS NOT NULL[\s\S]*\);/);
});

test('successful V1 runtime bootstrap records its ledger marker atomically',()=>{
  const marker="VALUES('20260826_LEGAL_ENTITIES_MULTI_COMPANY_V1','Legal entities multi-company runtime bootstrap')";
  assert.ok(sql.includes(marker));
  assert.match(sql,/ON CONFLICT\(version\) DO NOTHING;\s+\nCOMMIT;/);
});
