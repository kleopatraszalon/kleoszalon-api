const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const assert=require('node:assert/strict');

const route=fs.readFileSync(path.join(__dirname,'..','src','routes','kiosk.ts'),'utf8');
const runtime=fs.readFileSync(path.join(__dirname,'..','src','services','kioskWorkOrderRuntime.ts'),'utf8');

test('kiosk runtime restores legacy insert defaults even when generic readiness was optimistic',()=>{
  assert.match(route,/ensureKioskWorkOrderInsertCompatibility/);
  assert.match(runtime,/ALTER TABLE \$\{table\} ALTER COLUMN \$\{column\} SET DEFAULT/);
  for(const marker of ['visit_status','record_note','client_first_name','client_last_name','total_price','payment_status','document_status']){
    assert.match(runtime,new RegExp(marker));
  }
  assert.match(runtime,/trg_fill_work_order_item_line_no/);
  assert.match(runtime,/trg_sync_work_order_number_columns/);
});

test('legacy total recalculation cannot abort kiosk workorder transaction',()=>{
  assert.match(runtime,/SAVEPOINT \$\{sp\}/);
  assert.match(runtime,/ROLLBACK TO SAVEPOINT \$\{sp\}/);
  assert.match(runtime,/legacy recalc_work_order_totals/);
  assert.match(runtime,/fallback workorder totals/);
  assert.doesNotMatch(route,/if\(recalc\)await cx\.query\(`SELECT recalc_work_order_totals/);
  assert.match(route,/await finalizeKioskWorkOrderTotals\(cx,workOrderId,calculatedTotal\)/);
});

test('kiosk checkout reports exact failing stage and supports rollback-only live UAT',()=>{
  for(const stage of ['runtime-guard','client-find','client-create','official-number','workorder-header','items','totals','commit']){
    assert.match(route,new RegExp(stage));
  }
  assert.match(route,/validate_only/);
  assert.match(route,/x-kleo-kiosk-uat/);
  assert.match(route,/validated_only:validateOnly/);
  assert.match(route,/error_code:"kiosk_workorder_create_failed",stage,diagnostic/);
});
