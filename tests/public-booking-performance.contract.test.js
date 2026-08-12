const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const online=fs.readFileSync('src/routes/onlineBooking.ts','utf8'),schedule=fs.readFileSync('src/routes/bookingSchedule.ts','utf8');
test('public read-heavy endpoints use bounded caches',()=>{assert.match(online,/catalog:\$\{locationId/);assert.match(online,/5\*60_000/);assert.match(online,/publicCache\.get\("health"\)/);assert.match(schedule,/configCache/);assert.match(schedule,/shiftsCache/)});
test('blank employee names always fall back to Munkatárs',()=>{assert.match(online,/NULLIF\(btrim\(full_name\),''\)/);assert.match(schedule,/NULLIF\(btrim\(e\.full_name\),''\)/);assert.match(schedule,/'Munkatárs'/)});
