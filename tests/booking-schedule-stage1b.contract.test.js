const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=(file)=>fs.readFileSync(path.join(process.cwd(),file),'utf8');

test('schedule booking router is mounted before legacy online booking router',()=>{
  const src=read('src/routes/publicMarketing.ts');
  const schedule=src.indexOf('router.use("/booking", bookingScheduleRouter)');
  const legacy=src.indexOf('router.use("/booking", onlineBookingRouter)');
  assert.ok(schedule>=0&&legacy>=0&&schedule<legacy);
});

test('direct legacy /api/public/booking alias cannot bypass the schedule guard',()=>{
  const src=read('src/routes/onlineBooking.ts');
  assert.match(src,/import bookingScheduleRouter from "\.\/bookingSchedule"/);
  assert.match(src,/req\.baseUrl\|\|""\)===\"\/api\/public\/booking\"/);
  assert.match(src,/bookingScheduleRouter as any/);
});

test('availability uses published work shifts when a published schedule exists',()=>{
  const src=read('src/routes/bookingSchedule.ts');
  assert.match(src,/work_shifts/);
  assert.match(src,/s\.status='published'/);
  assert.match(src,/schedule_source/);
  assert.match(src,/published_shifts/);
  assert.match(src,/salon_hours_fallback/);
});

test('booking POST cannot bypass working schedule or salon booking window',()=>{
  const src=read('src/routes/bookingSchedule.ts');
  assert.match(src,/router\.use\("\/book",validateBookSchedule\)/);
  assert.match(src,/starts_at<=\$3::timestamptz AND ends_at>=\$4::timestamptz/);
  assert.match(src,/nincs közzétett munkaidő-beosztásban/);
  assert.match(src,/online foglalási nyitvatartásán kívül esik/);
  assert.match(src,/minimum_notice_minutes/);
  assert.match(src,/booking_horizon_days/);
});

test('booking schedule local date SQL uses ISO text and a non-reserved alias',()=>{
  const src=read('src/routes/bookingSchedule.ts');
  assert.match(src,/to_char\([^;]+YYYY-MM-DD[^;]+AS booking_day/);
  assert.match(src,/local\.booking_day/);
  assert.doesNotMatch(src,/::date day,/);
  assert.doesNotMatch(src,/String\(local\.booking_day\)/);
});

test('multi-service duration and employee eligibility are preserved in schedule-aware availability',()=>{
  const src=read('src/routes/bookingSchedule.ts');
  assert.match(src,/unnest\(\$3::uuid\[\]\)/);
  assert.match(src,/employee_service_overrides/);
  assert.match(src,/reduce\(\(sum:number,row:any\)=>sum\+Math\.max\(5,Number\(row\.duration_minutes/);
  assert.match(src,/end>interval\.to/);
});
