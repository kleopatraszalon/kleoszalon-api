const fs=require('fs');
const booking=fs.readFileSync('src/booking/ensureOnlineBooking.ts','utf8');
const scope=fs.readFileSync('src/middleware/locationManagerScope.ts','utf8');
for (const s of ['arrived','in_progress','completed','cancelled','no_show']) {
  if(!booking.includes(`'${s}'`)) throw new Error(`missing appointment status ${s}`);
}
if(!booking.includes('DROP CONSTRAINT IF EXISTS chk_appointments_status_phase3')) throw new Error('constraint migration missing');
if(!scope.includes('softenChecklistMy')) throw new Error('checklist soft fallback missing');
console.log('calendar/checklist hotfix smoke PASS');
