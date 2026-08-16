const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const sql=fs.readFileSync(path.join(__dirname,'..','src','sql','20260816_SAAS_TENANT_ISOLATION_V2.sql'),'utf8');

test('tenant backfill preserves legacy appointment rows without weakening future time-order validation',()=>{
  assert.match(sql,/pg_get_constraintdef\(c\.oid,\s*true\)/i);
  assert.match(sql,/chk_appointments_time_order_phase3/i);
  assert.match(sql,/ALTER TABLE appointments DISABLE TRIGGER USER/i);
  assert.match(sql,/ALTER TABLE appointments DROP CONSTRAINT chk_appointments_time_order_phase3/i);
  assert.match(sql,/SET CONSTRAINTS ALL IMMEDIATE/i);
  assert.match(sql,/ALTER TABLE appointments ADD CONSTRAINT %I %s NOT VALID/i);
  assert.match(sql,/'chk_appointments_time_order_phase3',\s*appointment_time_order_def/i);
  assert.match(sql,/ALTER TABLE appointments ENABLE TRIGGER USER/i);
});

test('legacy CHECK compatibility remains transactional and tenant integrity validation remains mandatory',()=>{
  assert.match(sql,/^BEGIN;/m);
  assert.match(sql,/COMMIT;/);
  assert.match(sql,/Tenant\/location mismatch in %: % rows/);
  assert.match(sql,/SET LOCAL statement_timeout = 0;/);
});
