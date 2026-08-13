const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const wrapper=read('src/routes/onlineBooking.ts');
const core=read('src/routes/onlineBookingCore.ts');
const resources=read('src/routes/onlineBookingResources.ts');

test('public booking keeps schedule guard and legacy core after resource layer',()=>{
 assert.match(wrapper,/bookingScheduleRouter/);
 assert.match(wrapper,/onlineBookingResourcesRouter/);
 assert.match(wrapper,/onlineBookingCoreRouter/);
 assert.ok(wrapper.indexOf('bookingScheduleRouter')<wrapper.indexOf('onlineBookingResourcesRouter'));
 assert.ok(wrapper.indexOf('router.use(onlineBookingResourcesRouter)')<wrapper.indexOf('router.use(onlineBookingCoreRouter)'));
 for(const marker of ['/health','/catalog','/recommendations','/availability','/book','/waitlist','/cancel/:token'])assert.ok(core.includes(marker),`missing legacy public route ${marker}`);
});

test('resource-aware availability is opt-in only for services with requirements',()=>{
 assert.match(resources,/service_resource_requirements/);
 assert.match(resources,/if\(!requirementCount\)return next\(\)/);
 assert.match(resources,/resource_aware:true/);
 assert.match(resources,/resourcesFit/);
});

test('online resource holds prevent booking races and expire automatically',()=>{
 assert.match(resources,/online_booking_resource_holds/);
 assert.match(resources,/expires_at/);
 assert.match(resources,/pg_advisory_xact_lock/);
 assert.match(resources,/resource_conflict:true/);
 assert.match(resources,/consumed_at/);
});

test('appointment service trigger converts holds to real resource allocations',()=>{
 assert.match(resources,/kleo_online_booking_resource_allocate/);
 assert.match(resources,/appointment_resource_allocations/);
 assert.match(resources,/online_voice/);
 assert.match(resources,/A szükséges erőforrás időközben foglalttá vált/);
});

test('resource planning treats a normal multi-service online booking sequentially',()=>{
 assert.match(resources,/cursor=new Date\(start\)/);
 assert.match(resources,/cursor=en/);
 assert.match(resources,/ORDER BY array_position/);
});
