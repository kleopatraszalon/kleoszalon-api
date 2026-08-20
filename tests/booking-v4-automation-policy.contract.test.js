const fs=require('fs');
const assert=require('assert');

const route=fs.readFileSync('src/routes/bookingV4Automation.ts','utf8');
const admin=fs.readFileSync('src/routes/bookingV4AdminPro.ts','utf8');

for(const marker of [
  'booking_automation_policy',
  'booking_automation_queue',
  'booking_automation_audit',
  'advisory',
  'assisted',
  'prepared',
  'approved',
  'cancelled',
  'no_show_threshold',
  'deposit_percent',
  'waitlist_first',
  'rebooking_enabled',
  'reminder_medium_risk',
  'ON CONFLICT(dedupe_key) DO NOTHING',
  'router.get("/policy"',
  'router.put("/policy"',
  'router.get("/queue"',
  'router.post("/queue/prepare"',
  'router.patch("/queue/:id"',
  'router.get("/audit"',
]) assert(route.includes(marker),`missing Booking 4 automation marker: ${marker}`);

assert(admin.includes('import bookingV4AutomationRouter from "./bookingV4Automation"'),'Booking 4 automation router import missing');
assert(admin.includes('router.use("/automation",bookingV4AutomationRouter)'),'Booking 4 automation mount missing');
assert(route.includes('nextStatus === "prepared"'),'queue prepared-state write guard missing');
assert(route.includes('before.status === "cancelled"'),'cancelled queue reactivation guard missing');
assert(route.includes('before.status === "approved" && nextStatus === "approved"'),'approved queue idempotency guard missing');

for(const forbidden of [
  /router\.(post|put|patch)\("\/queue\/execute"/,
  /router\.(post|put|patch)\("\/queue\/send"/,
  /router\.(post|put|patch)\("\/queue\/charge"/,
  /router\.(post|put|patch)\("\/send"/,
  /router\.(post|put|patch)\("\/charge"/,
]) assert(!forbidden.test(route),`unsafe external side-effect endpoint detected: ${forbidden}`);

console.log('Booking 4 automation policy safety contract OK');
