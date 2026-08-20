const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=(rel)=>fs.readFileSync(path.join(__dirname,'..',rel),'utf8');

// Keep this contract on the current release-gate path: revenue changes must
// continue to prove fail-closed billing, idempotency and lifecycle recovery.
const route=read('src/routes/saasRevenue.ts');
const provider=read('src/saas/stripeBilling.ts');
const saas=read('src/routes/saas.ts');
const migration=read('src/sql/20260819_SAAS_REVENUE_ENGINE_V16.sql');

test('Revenue Engine exposes catalog, checkout, portal, coupon and dunning endpoints',()=>{
 assert.match(route,/router\.get\("\/catalog"/);
 assert.match(route,/router\.post\("\/checkout"/);
 assert.match(route,/router\.post\("\/portal"/);
 assert.match(route,/router\.post\("\/coupons\/validate"/);
 assert.match(route,/router\.post\("\/dunning\/run"/);
 assert.match(saas,/router\.use\("\/revenue",saasRevenueRouter\)/);
 assert.match(saas,/router\.use\("\/billing",saasRevenuePublicRouter\)/);
});

test('Stripe integration is fail closed and checkout is recurring',()=>{
 assert.match(provider,/STRIPE_NOT_CONFIGURED/);
 assert.match(provider,/STRIPE_TAX_NOT_CONFIGURED/);
 assert.match(provider,/mode","subscription/);
 assert.match(provider,/price_data\]\[recurring\]\[interval/);
 assert.match(provider,/billing_portal\/sessions/);
 assert.match(provider,/Idempotency-Key/);
});

test('Webhook processing retrieves canonical Stripe event and is idempotent',()=>{
 assert.match(route,/retrieveStripeEvent\(eventId\)/);
 assert.match(provider,/\/events\/\$\{encodeURIComponent\(eventId\)\}/);
 assert.match(provider,/billing_webhook_events/);
 assert.match(provider,/ON CONFLICT\(provider,external_event_id\) DO NOTHING/);
 assert.match(provider,/invoice\.payment_failed/);
 assert.match(provider,/invoice\.paid/);
 assert.match(provider,/customer\.subscription\./);
});

test('Payment failure drives grace and suspension while paid invoice recovers tenant',()=>{
 assert.match(provider,/grace_period_end=COALESCE\(grace_period_end,now\(\)\+interval '7 days'\)/);
 assert.match(provider,/dunning_step=LEAST/);
 assert.match(provider,/status='suspended'/);
 assert.match(provider,/UPDATE tenants SET status='active'/);
 assert.match(provider,/last_payment_status='paid'/);
});

test('Commercial catalog persists the agreed prices and zero booking commission',()=>{
 assert.match(migration,/monthly_price=29900,annual_price=299000/);
 assert.match(migration,/monthly_price=59900,annual_price=599000/);
 assert.match(migration,/monthly_price=149900,annual_price=1499000/);
 assert.match(migration,/monthly_price=299900,annual_price=2999000/);
 assert.match(migration,/booking_commission_percent=0/);
 assert.match(migration,/trial_days=14/);
});