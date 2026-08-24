const fs=require('fs');
const test=require('node:test');
const assert=require('node:assert/strict');
const hash='$2b$12$Zea7mWMY.2wv.oUi.WwFJOfrsbBbxdOEHv8r5dbyq7W76NFUJIsQ.';
const auth=fs.readFileSync('src/routes/auth.ts','utf8');
const accounting=fs.readFileSync('src/accounting/ensureAccountingUser.ts','utf8');
const migration=fs.readFileSync('src/migrations/20260824_001_unified_demo_passwords.sql','utf8');
const checklist=fs.readFileSync('src/checklists/ensureChecklists.ts','utf8');

test('all requested role demo accounts use the common test password hash',()=>{
 assert.ok(auth.includes(hash));
 assert.ok(accounting.includes(hash));
 for(const login of ['szalonvezeto1','vezeto1','hr1','könyvelés','recepcio1','recepcio2','kozmetikus1','kozmetikus2'])assert.ok(migration.includes(login));
 assert.ok(checklist.includes('20260824_DEMO_PASSWORDS_V3.sql'));
});
