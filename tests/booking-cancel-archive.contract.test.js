const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=file=>fs.readFileSync(path.join(process.cwd(),file),'utf8');

test('online booking bootstrap repairs legacy workorder child timestamps before terminal cancellation',()=>{
  const src=read('src/booking/ensureOnlineBooking.ts');
  assert.match(src,/to_regclass\('public\.work_order_items'\)/);
  assert.match(src,/ALTER TABLE work_order_items ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now\(\)/);
  assert.match(src,/to_regclass\('public\.work_order_payments'\)/);
  assert.match(src,/ALTER TABLE work_order_payments ADD COLUMN IF NOT EXISTS paid_at timestamptz NOT NULL DEFAULT now\(\)/);
});

test('public booking cancellation bootstraps the repaired schema before changing workorder status',()=>{
  const src=read('src/routes/onlineBooking.ts');
  const route=src.indexOf('router.post("/cancel/:token"');
  const ensure=src.indexOf('await ensureOnlineBooking();',route);
  const update=src.indexOf("UPDATE work_orders SET status='cancelled'",route);
  assert.ok(route>=0&&ensure>route&&update>ensure,'schema repair must run before terminal workorder update');
});

test('customer self-service bootstrap also runs online booking schema repair',()=>{
  const src=read('src/customerPortal/ensureCustomerPortal.ts');
  assert.match(src,/await ensureOnlineBooking\(\)/);
});
