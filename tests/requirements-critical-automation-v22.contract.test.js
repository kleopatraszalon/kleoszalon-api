'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

const resolver=()=>read('src/marketing/dailyActionApplicability.ts');
const dailyActions=()=>read('src/routes/dailyActions.ts');
const cashier=()=>read('src/routes/workOrderCashierFast.ts');

// KLEO-FUN-PROMO-001 / KLEO-FUN-PROMO-001-AC-01
test('eligible active promotion is resolved once by the same location/time/audience rule for display and financial discount',()=>{
 const r=resolver(),d=dailyActions(),c=cashier();
 assert.match(r,/export async function applicableDailyActions/);
 assert.match(r,/status='published'/);
 assert.match(r,/valid_from<=\$1::timestamptz AND valid_until>=\$1::timestamptz/);
 assert.match(r,/location_id::text=\$2/);
 assert.match(r,/audienceEligible/);
 assert.match(r,/ORDER BY valid_until,id/);
 assert.match(d,/applicableDailyActions\(db,\{locationId:/);
 assert.match(d,/clientId:String\(req\.query\.client_id/);
 assert.match(c,/dailyActionDiscountForWorkOrder\(c,req\.params\.id,gross\)/);
 assert.match(c,/Math\.max\(requestedDiscount,money\(loyalty\.amount\),money\(promo\.amount\)\)/);
 assert.match(r,/work_order_items WHERE work_order_id::text=\$1 AND service_id::text=\$2/);
 assert.match(r,/if\(amount>best\.amount\)best=/);
});

// KLEO-FUN-PROMO-001 / KLEO-FUN-PROMO-001-AC-02
test('expired future or wrong-location promotion cannot reach display or financial calculation',()=>{
 const r=resolver(),d=dailyActions(),c=cashier();
 assert.match(r,/valid_from<=\$1::timestamptz AND valid_until>=\$1::timestamptz/);
 assert.match(r,/location_id IS NULL AND COALESCE\(auto_selector_meta->>'location_id',''\)=''\)/);
 assert.match(r,/OR auto_selector_meta->>'location_id'=\$2/);
 assert.ok(!/SELECT id,headline,description_html,image_url,cta_label,cta_url,discount_text,valid_from,valid_until FROM daily_action_campaigns WHERE status='published'/.test(d),'public display must not bypass canonical applicability resolver');
 assert.match(c,/promo=await dailyActionDiscountForWorkOrder/);
 assert.match(r,/const actions=await applicableDailyActions\(q,\{locationId:wo\.location_id,clientId:wo\.client_id,at:new Date\(\)\}\)/);
 assert.match(r,/if\(!\(pct>0\)\)continue/);
});
