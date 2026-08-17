import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

// KLEO-GEN-FLTR-001 / KLEO-GEN-FLTR-001-AC-01
// KLEO-GEN-FLTR-001 / KLEO-GEN-FLTR-001-AC-02
const frontend=path.resolve(process.argv[2]||'frontend');
const env={...process.env,CI:'true'};
execFileSync('npm',['test','--','--watchAll=false','--runInBand','--runTestsByPath','src/utils/tableFilters.test.ts','src/pages/ColumnFilterRolloutV26.test.ts'],{cwd:frontend,stdio:'inherit',env});

const staff=fs.readFileSync(path.join(frontend,'src/pages/EmployeesList.tsx'),'utf8');
const audit=fs.readFileSync(path.join(frontend,'src/pages/AuditLogPage.tsx'),'utf8');
const archive=fs.readFileSync(path.join(frontend,'src/pages/ArchiveCenterPage.tsx'),'utf8');
const engine=fs.readFileSync(path.join(frontend,'src/utils/tableFilters.ts'),'utf8');

assert.match(staff,/staff-column-filter-row/,'staff business table must render a filter row directly in the header');
for(const token of ['columnFilters.name','columnFilters.location','columnFilters.employment','columnFilters.monthlyMin','columnFilters.hourlyMin','columnFilters.commissionMin','columnFilters.status']) assert.ok(staff.includes(token),`missing typed staff column filter: ${token}`);
assert.match(staff,/applyColumnFilters\(baseRows/,'staff table must use the shared column filter engine');
assert.match(staff,/staff\.found[^\n]*filtered\.length|filtered\.length/,'staff result count must derive from the filtered row set');

for(const token of ['audit-module-filter','audit-action-filter','audit-severity-filter','audit-object-filter','audit-identifier-filter','audit-user-filter','audit-location-filter']) assert.ok(audit.includes(token),`missing Audit Log header filter: ${token}`);
assert.match(audit,/applyColumnFilters\(rows, localFilters, locale\)/,'Audit Log must use the shared column filter engine');
assert.match(audit,/count=\{filteredRows\.length\}/,'Audit Log result count must derive from the filtered row set');

for(const token of ['archive-entity-filter','archive-name-filter','archive-date-filter','archive-user-filter','archive-reason-filter']) assert.ok(archive.includes(token),`missing Archive header filter: ${token}`);
assert.match(archive,/applyColumnFilters\(rows, filters, locale\)/,'Archive must use the shared column filter engine');
assert.match(archive,/filteredRows\.length/,'Archive result count/render set must derive from filtered rows');

assert.match(engine,/active\.every\(filter =>/,'multiple active column filters must be combined with AND semantics');
assert.match(engine,/number-min/,'numeric column predicates must be supported');
assert.match(engine,/kind === "select"/,'list column predicates must be supported');
assert.match(engine,/kind === "boolean"/,'status/boolean column predicates must be supported');
console.log('PASS KLEO v25/v26 column-filter cross-repo acceptance evidence across Staff, Audit and Archive tables.');
