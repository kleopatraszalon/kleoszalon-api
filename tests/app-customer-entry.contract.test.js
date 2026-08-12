const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../src/routes/publicMarketing.ts'),'utf8');
test('app registration creates a customer account and linked client',()=>{assert.match(source,/router\.post\("\/app\/register"/);assert.match(source,/role:\"customer\"/);assert.match(source,/kleopatra_app_registered/);assert.match(source,/customer_id:customerId/)});
test('guest entry is persisted and tagged as not registered',()=>{assert.match(source,/router\.post\("\/app\/guest"/);assert.match(source,/Nem regisztrált/);assert.match(source,/crm_client_tags/);assert.match(source,/kleopatra_app_guest/)});
