const fs=require('fs');

const access=fs.readFileSync('src/middleware/timetableSelfAccess.ts','utf8');

for(const alias of ['receptionist','reception','recepciós','recepcios']){
  if(!access.includes(`"${alias}"`)) throw new Error(`missing receptionist alias ${alias}`);
}
if(!access.includes('if(!receptionist(req))')) throw new Error('receptionist GET timetable gate missing');
if(!access.includes('(req.query as any).location_id=locationId')) throw new Error('own salon query scope missing');
if(!access.includes('scopeTimetableResponse(res,locationId)')) throw new Error('own salon response scope missing');
if(!access.includes('appointmentLocation===locationId')) throw new Error('appointment location filter missing');
if(!access.includes('employeeIds.has(String(row?.employee_id??""))')) throw new Error('legacy null-location appointment fallback missing');
if(!access.includes('A recepciós fiókhoz nincs szalon rendelve.')) throw new Error('fail-closed receptionist location guard missing');

console.log('receptionist timetable own-salon contract PASS');
