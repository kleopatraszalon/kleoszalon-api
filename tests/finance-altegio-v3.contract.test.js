const fs=require('fs');
const assert=require('assert');
const route=fs.readFileSync('src/routes/financeAltegio.ts','utf8');
const transactions=fs.readFileSync('src/routes/transactions.ts','utf8');
const required=[
  "router.get('/dashboard'","router.get('/partners'","router.post('/partners'",
  "router.get('/document-types'","router.post('/document-types'",
  "router.get('/payment-methods'","router.post('/payment-methods'",
  "router.get('/documents'","router.post('/documents'",
  "router.get('/operations'","router.post('/operations/:id/cancel'",
  "router.get('/reports/summary'","router.get('/reports/pnl'","router.get('/reports/partner-balances'",
  "router.get('/online-settings'","router.put('/online-settings'"
];
for(const marker of required)assert(route.includes(marker),`missing finance route: ${marker}`);
assert(route.includes('CREATE TABLE IF NOT EXISTS finance_partners'),'partner schema missing');
assert(route.includes('CREATE TABLE IF NOT EXISTS finance_document_types'),'document type schema missing');
assert(route.includes('CREATE TABLE IF NOT EXISTS finance_payment_methods'),'payment method schema missing');
assert(route.includes('CREATE TABLE IF NOT EXISTS finance_documents'),'document registry schema missing');
assert(route.includes('CREATE TABLE IF NOT EXISTS finance_online_settings'),'online settings schema missing');
assert(route.includes('["employee","customer","guest"]'),'operational finance role guard missing');
assert(transactions.includes('financeAltegioRouter'),'finance Altegio router import missing');
assert(transactions.includes('/finance-operations/altegio'),'finance Altegio router mount missing');
console.log('Finance Altegio v3 contract OK');
