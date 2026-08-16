import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const base=require(path.join(root,'docs/requirements/catalog.cjs'));
const operational=require(path.join(root,'docs/requirements/catalog.operational.cjs'));
const automation=require(path.join(root,'docs/requirements/automation.cjs'));
const all=[...base.requirements,...operational.requirements];
const criteria=new Map(all.flatMap(r=>r.acceptance_criteria.map(a=>[a.id,{requirement:r,criterion:a}])));
const errors=[];
const seen=new Set();
for(const entry of automation.entries||[]){
  if(seen.has(entry.criterion_id))errors.push(`Duplikált automation mapping: ${entry.criterion_id}`);
  seen.add(entry.criterion_id);
  const target=criteria.get(entry.criterion_id);
  if(!target){errors.push(`Ismeretlen elfogadási kritérium: ${entry.criterion_id}`);continue;}
  if(!['contract','security','unit','integration','e2e','performance','resilience'].includes(entry.execution_type))errors.push(`${entry.criterion_id}: hibás execution_type`);
  const testPath=path.join(root,entry.test_ref||'');
  if(!entry.test_ref||!fs.existsSync(testPath)){errors.push(`${entry.criterion_id}: hiányzó tesztfájl ${entry.test_ref||''}`);continue;}
  const src=fs.readFileSync(testPath,'utf8');
  if(!src.includes(entry.criterion_id))errors.push(`${entry.criterion_id}: a tesztfájl nem hivatkozik a kritérium-ID-ra`);
  if(!src.includes(target.requirement.id))errors.push(`${entry.criterion_id}: a tesztfájl nem hivatkozik a követelmény-ID-ra`);
}
const automated=seen.size,total=criteria.size;
const percent=total?Math.round(automated*1000/total)/10:0;
console.log(`Automatizált elfogadási kritériumok: ${automated}/${total} (${percent}%)`);
console.log(`Manuális/integrációs evidence-re vár: ${total-automated}/${total}`);
if(errors.length){for(const e of errors)console.error('ERROR',e);process.exitCode=1}else console.log('PASS Requirement automation registry konzisztens.');
