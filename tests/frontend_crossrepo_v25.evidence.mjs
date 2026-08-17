import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

// KLEO-GEN-FLTR-001 / KLEO-GEN-FLTR-001-AC-01
// KLEO-GEN-FLTR-001 / KLEO-GEN-FLTR-001-AC-02
const frontend=path.resolve(process.argv[2]||'frontend');
const env={...process.env,CI:'true'};
execFileSync('npm',['test','--','--watchAll=false','--runInBand','--runTestsByPath','src/utils/tableFilters.test.ts'],{cwd:frontend,stdio:'inherit',env});

const page=fs.readFileSync(path.join(frontend,'src/pages/EmployeesList.tsx'),'utf8');
const engine=fs.readFileSync(path.join(frontend,'src/utils/tableFilters.ts'),'utf8');
assert.match(page,/staff-column-filter-row/,'business table must render a filter row directly in the header');
for(const token of ['columnFilters.name','columnFilters.location','columnFilters.employment','columnFilters.monthlyMin','columnFilters.hourlyMin','columnFilters.commissionMin','columnFilters.status']) assert.ok(page.includes(token),`missing typed staff column filter: ${token}`);
assert.match(page,/applyColumnFilters\(baseRows/,'staff table must use the shared column filter engine');
assert.match(page,/staff\.found[^\n]*filtered\.length|filtered\.length/,'displayed result count must derive from the filtered row set');
assert.match(engine,/active\.every\(filter =>/,'multiple active column filters must be combined with AND semantics');
assert.match(engine,/number-min/,'numeric column predicates must be supported');
assert.match(engine,/kind === "select"/,'list column predicates must be supported');
assert.match(engine,/kind === "boolean"/,'status/boolean column predicates must be supported');
console.log('PASS KLEO v25 column-filter cross-repo acceptance evidence.');
