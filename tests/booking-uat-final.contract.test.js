const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=file=>fs.readFileSync(path.join(process.cwd(),file),'utf8');

test('final booking UAT migration is part of finance/UAT bootstrap',()=>{
  const bootstrap=read('src/finance/ensureFinanceNav.ts');
  assert.match(bootstrap,/20260814_BOOKING_UAT_FINAL_V1\.sql/);
});

test('final booking UAT covers the critical customer journeys',()=>{
  const sql=read('src/sql/20260814_BOOKING_UAT_FINAL_V1.sql');
  for(const code of [
    'UAT-BOOK-001','UAT-BOOK-002','UAT-BOOK-003','UAT-BOOK-004','UAT-BOOK-005',
    'UAT-BOOK-006','UAT-BOOK-007','UAT-BOOK-008','UAT-BOOK-009','UAT-BOOK-010'
  ]) assert.match(sql,new RegExp(code));
  assert.match(sql,/Publikus vendégfoglalás/);
  assert.match(sql,/Bejelentkezett ügyfél/);
  assert.match(sql,/Több szolgáltatás/);
  assert.match(sql,/Időpontütközés/);
  assert.match(sql,/Várólista/);
  assert.match(sql,/módosítása tokennel/);
  assert.match(sql,/lemondása tokennel/);
  assert.match(sql,/Ajánlott szolgáltatás/);
  assert.match(sql,/adatvédelem/);
});

test('new booking cases are backfilled into already open UAT runs',()=>{
  const sql=read('src/sql/20260814_BOOKING_UAT_FINAL_V1.sql');
  assert.match(sql,/INSERT INTO uat_test_results/);
  assert.match(sql,/r\.status='open'/);
  assert.match(sql,/c\.module_key='booking'/);
  assert.match(sql,/ON CONFLICT\(run_id,test_case_id\) DO NOTHING/);
});
