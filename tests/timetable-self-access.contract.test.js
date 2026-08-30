const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const source=fs.readFileSync(path.join(__dirname,'..','src','middleware','timetableSelfAccess.ts'),'utf8');

test('timetable management guard recognizes all salon-manager aliases',()=>{
  for(const role of ['salon_manager','szalonvezető','szalonvezeto']){
    assert.ok(source.includes(`"${role}"`),`${role} must stay elevated for timetable management`);
  }
});

test('employee self-service restrictions remain after the management fast path',()=>{
  assert.match(source,/if\(elevated\(req\)\)return next\(\)/);
  assert.match(source,/Munkatársként csak a saját beosztása szerkeszthető/);
  assert.match(source,/A beosztás közzététele vezetői jogosultságot igényel/);
});
