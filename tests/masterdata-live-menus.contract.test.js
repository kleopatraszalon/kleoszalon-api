const fs=require('fs');
const assert=require('assert');
const path=require('path');
const read=(p)=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

const sql=read('src/sql/20260813_MASTERDATA_LIVE_MENUS_V2.sql');
const bootstrap=read('src/virSpec/ensureVirSpecModules.ts');

for(const marker of [
  'masterdata.user-groups','/admin/access-control',
  'masterdata.users','/employees',
  'masterdata.discounts','/spec/discounts',
  'masterdata.warehouses','/masterdata/warehouses',
  'Vendégszámla-tranzakciótípusok','/spec/guest-account-transaction-types',
  'discount_type','service_value','product_value','service_category','product_type',
  'valid_from','valid_until','time_from','time_to','financial_transaction_type',
  'Spec. 3.12. Kedvezmények','Spec. 3.21. Vendég számla tranzakciók'
]) assert(sql.includes(marker),`missing master data marker: ${marker}`);

assert(bootstrap.includes('20260813_MASTERDATA_LIVE_MENUS_V2.sql'),'master data live menu migration missing from bootstrap');
assert(bootstrap.includes('20260813_NOTIFICATION_CENTER_MENU_V1.sql'),'notification center menu migration missing from bootstrap');
console.log('Master data live menu contract OK');
