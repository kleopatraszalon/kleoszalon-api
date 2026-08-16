const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const cashier=fs.readFileSync('src/routes/workOrderCashierFast.ts','utf8');
const ledger=fs.readFileSync('src/franchise/franchiseRevenueLedger.ts','utf8');

test('paid retail sale posts net revenue to franchise ledger inside the same transaction',()=>{
  assert.ok(cashier.includes("recordFranchiseRevenueIfApplicable"));
  assert.ok(cashier.includes("sourceType:'retail_sale'"));
  assert.ok(cashier.includes('sourceId:String(sale.id)'));
  assert.ok(cashier.includes('netRevenue:netTotal'));
  const post=cashier.indexOf('const franchiseRevenue=await recordFranchiseRevenueIfApplicable');
  const commit=cashier.indexOf("await c.query('COMMIT');",post);
  assert.ok(post>=0&&commit>post,'franchise revenue must be posted before the retail transaction commits');
});

test('retail franchise basis is VAT-exclusive and traceable to the paid sale',()=>{
  assert.ok(cashier.includes('x.gross/(1+Number(x.vat_rate||0.27))'));
  assert.ok(cashier.includes('gross_total:total'));
  assert.ok(cashier.includes('payment_method:method'));
  assert.ok(cashier.includes('finance_invoice_id:invoice?.id||null'));
  assert.ok(cashier.includes('franchise_revenue_posted:franchiseRevenue.posted'));
});

test('ledger posting is idempotent and does not classify owned/non-franchise salons as franchise revenue',()=>{
  assert.ok(ledger.includes("fm.member_type='franchise'"));
  assert.ok(ledger.includes('fm.active=true'));
  assert.ok(ledger.includes('ON CONFLICT(tenant_id,source_type,source_id) DO NOTHING'));
  assert.ok(ledger.includes('reason:"not_franchise"'));
  assert.ok(ledger.includes('reason:"duplicate"'));
});

test('ledger helper does not break cashier when SaaS ledger schema is not deployed yet',()=>{
  assert.ok(ledger.includes("to_regclass('public.franchise_members')"));
  assert.ok(ledger.includes("to_regclass('public.franchise_revenue_entries')"));
  assert.ok(ledger.includes('reason:"schema_unavailable"'));
});
