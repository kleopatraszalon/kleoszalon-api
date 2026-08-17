import fs from 'node:fs';
const path='src/routes/employees.ts';
let s=fs.readFileSync(path,'utf8');
const before='filters.push(`e.location_id::text=${values.length}::text`)';
const after='filters.push(`e.location_id::text=$${values.length}::text`)';
if(!s.includes(before))throw new Error('Expected employee location placeholder patch target not found');
s=s.replace(before,()=>after);
fs.writeFileSync(path,s,'utf8');
console.log('Employee location parameter placeholder corrected.');
