import fs from 'node:fs';
const path='src/routes/employees.ts';
let s=fs.readFileSync(path,'utf8');
function once(before,after,label){
  if(!s.includes(before))throw new Error(`Missing patch target: ${label}`);
  s=s.replace(before,after);
}
once(
  'async function listEmployeesLegacy(includeInactive:boolean,locationId:string|null=null){const filters:string[]=[];const values:any[]=[];if(!includeInactive)filters.push("COALESCE(e.active,true)=true");if(locationId){values.push(locationId);filters.push(`e.location_id::text=$${values.length}::text`)}const where=filters.length?`WHERE ${filters.join(" AND ")}`:"";return pool.query(`${employeeSelect} ${where} ORDER BY e.active DESC,e.full_name NULLS LAST,e.last_name,e.first_name`,values)}',
  'async function listEmployeesLegacyScoped(includeInactive:boolean,locationId:string|null){const filters:string[]=[];const values:any[]=[];if(!includeInactive)filters.push("COALESCE(e.active,true)=true");if(locationId){values.push(locationId);filters.push(`e.location_id::text=$${values.length}::text`)}const where=filters.length?`WHERE ${filters.join(" AND ")}`:"";return pool.query(`${employeeSelect} ${where} ORDER BY e.active DESC,e.full_name NULLS LAST,e.last_name,e.first_name`,values)}\nasync function listEmployeesLegacy(includeInactive:boolean){return listEmployeesLegacyScoped(includeInactive,null)}',
  'legacy helper split'
);
const old='if(!paginated){const locationId=String(req.query.location_id||"").trim()||null;const{rows}=await listEmployeesLegacy(includeInactive,locationId);return res.json(rows)}';
const replacement='if(!paginated){const locationId=String(req.query.location_id||"").trim()||null;const{rows}=locationId?await listEmployeesLegacyScoped(includeInactive,locationId):await listEmployeesLegacy(includeInactive);return res.json(rows)}';
let count=0;
while(s.includes(old)){s=s.replace(old,replacement);count++}
if(count!==2)throw new Error(`Expected 2 non-paginated fast-path calls, patched ${count}`);
fs.writeFileSync(path,s,'utf8');
console.log('Employee no-DDL fast-path contract restored with location-scoped helper.');
