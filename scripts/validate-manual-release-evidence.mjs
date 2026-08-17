import fs from 'node:fs';

const file = process.argv[2] || 'artifacts/manual-release-evidence.json';
if (!fs.existsSync(file)) {
  console.error(`ERROR missing manual release evidence: ${file}`);
  process.exit(1);
}

let evidence;
try { evidence = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch { console.error('ERROR manual release evidence is not valid JSON'); process.exit(1); }

const errors = [];
const requiredText = ['release_ref', 'environment', 'tester', 'executed_at', 'approval_status'];
for (const key of requiredText) if (!String(evidence?.[key] || '').trim()) errors.push(`missing ${key}`);
if (!['approved', 'rejected'].includes(String(evidence?.approval_status || '').toLowerCase())) errors.push('approval_status must be approved or rejected');
if (Number.isNaN(Date.parse(String(evidence?.executed_at || '')))) errors.push('executed_at must be an ISO timestamp');
if (!Array.isArray(evidence?.test_cases) || evidence.test_cases.length === 0) errors.push('test_cases must contain at least one manual test case');
else {
  const ids = new Set();
  for (const [index, item] of evidence.test_cases.entries()) {
    const prefix = `test_cases[${index}]`;
    for (const key of ['id', 'result', 'evidence_ref']) if (!String(item?.[key] || '').trim()) errors.push(`${prefix}.${key} is required`);
    if (!['passed', 'failed', 'blocked'].includes(String(item?.result || '').toLowerCase())) errors.push(`${prefix}.result must be passed, failed or blocked`);
    if (item?.id) { if (ids.has(item.id)) errors.push(`duplicate test case id: ${item.id}`); ids.add(item.id); }
  }
}
if (String(evidence?.approval_status || '').toLowerCase() === 'approved') {
  const blockers = (evidence?.test_cases || []).filter(x => String(x?.result || '').toLowerCase() !== 'passed');
  if (blockers.length) errors.push(`approved evidence contains non-passed cases: ${blockers.map(x => x.id).join(', ')}`);
}

if (errors.length) {
  for (const error of errors) console.error(`ERROR ${error}`);
  process.exit(1);
}
console.log(`PASS manual release evidence: ${evidence.release_ref} / ${evidence.environment} / ${evidence.tester} / ${evidence.test_cases.length} cases / ${evidence.approval_status}`);
