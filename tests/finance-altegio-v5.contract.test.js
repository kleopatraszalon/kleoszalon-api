const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const route=fs.readFileSync(path.join(__dirname,'../src/routes/financeAltegioV5.ts'),'utf8');
const schema=fs.readFileSync(path.join(__dirname,'../src/sql/20260813_FINANCE_ALTEGIO_V5.sql'),'utf8');
const tx=fs.readFileSync(path.join(__dirname,'../src/routes/transactions.ts'),'utf8');
const menu=fs.readFileSync(path.join(__dirname,'../src/finance/ensureFinanceV5Menu.ts'),'utf8');
const bootstrap=fs.readFileSync(path.join(__dirname,'../src/finance/ensureFinanceNav.ts'),'utf8');
const integrity=fs.readFileSync(path.join(__dirname,'../src/finance/financialIntegrity.ts'),'utf8');

test('finance v5 schema covers Altegio-style master and transaction data',()=>{
  for(const name of ['finance_partners','finance_payment_methods','finance_documents','finance_settings_v5','financial_accounts','financial_movements'])assert.match(schema,new RegExp(name));
  for(const field of ['fee_percent','processing_days','payment_method_id','partner_id','document_id','cancelled_at','work_order_id'])assert.match(schema,new RegExp(field));
  assert.match(schema,/acquiring_fee/);assert.match(schema,/procurement_supplier/);
});

test('finance v5 api covers accounts partners transactions documents reports and settings',()=>{
  for(const endpoint of ['/dashboard','/accounts','/transfers','/partners','/categories','/payment-methods','/movements','/documents','/reports/pl','/reports/daily-cash','/settings','/online-payment'])assert.ok(route.includes(`"${endpoint}`),endpoint);
  assert.match(route,/fee_movement/);assert.match(route,/\/movements\/:id\/cancel/);assert.match(integrity,/payment_status='cancelled'/);
  assert.match(route,/finance_v5_forbidden/);assert.match(route,/location_manager/);assert.match(route,/receptionist/);
});

test('finance v5 is mounted into transactions and bootstrapped',()=>{
  assert.match(tx,/financeAltegioV5Router/);assert.match(tx,/router\.use\("\/finance-v5"/);
  assert.match(bootstrap,/20260813_FINANCE_ALTEGIO_V5\.sql/);assert.match(bootstrap,/ensureFinanceV5Menu/);
});

test('finance v5 menu exposes requested administration areas with scoped roles',()=>{
  for(const code of ['finance.dashboard','finance.checkout','finance.transactions','finance.cash','finance.partners','finance.payment_categories','finance.documents','finance.online','finance.reports','finance.payment_methods','finance.settings'])assert.match(menu,new RegExp(code.replace('.','\\.')));
  assert.match(menu,/\/finance\/accounts/);assert.match(menu,/\/finance\/partners/);assert.match(menu,/\/finance\/payment-methods/);
  assert.match(menu,/all_locations/);assert.match(menu,/own_location/);assert.match(menu,/employee/);assert.match(menu,/customer/);
});
