const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const wrapper=read('src/routes/bookingOperations.ts');
const core=read('src/routes/bookingOperationsCore.ts');
const advanced=read('src/routes/bookingAdvanced.ts');

test('legacy booking operations remain mounted before Stage15 advanced routes',()=>{
 assert.match(wrapper,/bookingOperationsCoreRouter/);
 assert.match(wrapper,/bookingAdvancedRouter/);
 assert.ok(wrapper.indexOf('router.use(bookingOperationsCoreRouter)')<wrapper.indexOf('router.use("\/advanced",bookingAdvancedRouter)'));
 for(const marker of ['/waitlist','/breaks','/appointments/:id/reschedule','/appointments/:id/repeat'])assert.ok(core.includes(marker),`missing legacy ${marker}`);
});

test('Stage15 adds salon resources and service resource requirements',()=>{
 for(const marker of ['booking_resources','service_resource_requirements','appointment_resource_allocations',"router.get('/resources'","router.post('/resources'","router.get('/service-resources/:serviceId'","router.put('/service-resources/:serviceId'"])assert.ok(advanced.includes(marker),`missing ${marker}`);
});

test('Stage15 models multiple staff and parallel 4Hands mode',()=>{
 assert.match(advanced,/appointment_staff_assignments/);
 assert.match(advanced,/booking_mode/);
 assert.match(advanced,/parallel/);
 assert.match(advanced,/sequential/);
 assert.match(advanced,/assigned_employee_id/);
 assert.match(advanced,/scheduled_start_time/);
 assert.match(advanced,/scheduled_end_time/);
});

test('advanced availability checks staff breaks appointments secondary staff and resources',()=>{
 assert.match(advanced,/appointment_technical_breaks/);
 assert.match(advanced,/appointment_staff_assignments asa JOIN appointments/);
 assert.match(advanced,/appointment_resource_allocations ara JOIN appointments/);
 assert.match(advanced,/pg_advisory_xact_lock/);
 assert.match(advanced,/booking-resource:/);
 assert.match(advanced,/booking-staff:/);
});

test('advanced appointment creates legacy appointment services work order and audit snapshot',()=>{
 assert.match(advanced,/INSERT INTO appointments/);
 assert.match(advanced,/INSERT INTO appointment_services/);
 assert.match(advanced,/advanced_created/);
 assert.match(advanced,/ensureBookingWorkOrder/);
 assert.match(advanced,/source_snapshot/);
 assert.match(advanced,/resource_allocations/);
});

test('resource configuration is manager protected',()=>{
 assert.match(advanced,/requireManager/);
 assert.match(advanced,/Erőforrás-beállítást csak adminisztrátor vagy vezető módosíthat/);
});
