import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = require(path.join(root, 'docs/requirements/catalog.cjs'));
const matrixPath = path.join(root, 'docs/requirements/TRACEABILITY.md');
const writeMatrix = process.argv.includes('--write-matrix');
const requirementPattern = /^KLEO-(?:GEN|FUN|NFR)-[A-Z0-9]+-\d{3}$/;
const methods = new Set(['unit', 'contract', 'integration', 'e2e', 'security', 'performance', 'resilience', 'inspection', 'manual']);
const priorities = new Set(['must', 'should', 'could']);
const lifecycleStatuses = new Set(['draft', 'approved', 'deprecated']);
const automationStatuses = new Set(['planned', 'automated', 'manual']);
const vague = /\b(gyors|könnyű|megfelelő|optimális|felhasználóbarát|stb\.)\b/i;

const errors = [];
const allRequirementIds = catalog.requirements.map((item) => item.id);
const allAcceptanceIds = catalog.requirements.flatMap((item) => item.acceptance_criteria.map((criterion) => criterion.id));
const unique = (values) => new Set(values).size === values.length;
const nonEmpty = (value) => typeof value === 'string' && value.trim().length >= 8;

for (const requirement of catalog.requirements) {
  if (!requirementPattern.test(requirement.id)) errors.push(`${requirement.id}: hibás követelmény-ID`);
  if (!nonEmpty(requirement.title) || !nonEmpty(requirement.statement) || vague.test(requirement.statement)) errors.push(`${requirement.id}: nem egyértelmű követelményszöveg`);
  if (requirement.source?.document !== catalog.requirements[0].source.document || requirement.source?.version !== '2' || !Number.isInteger(requirement.source?.page) || requirement.source.page < 1 || requirement.source.page > 155 || !nonEmpty(requirement.source?.section)) errors.push(`${requirement.id}: hiányos PDF-forrás`);
  if (!priorities.has(requirement.priority) || !nonEmpty(requirement.owner_role) || !lifecycleStatuses.has(requirement.lifecycle_status)) errors.push(`${requirement.id}: hiányos irányítási metaadat`);
  if (!Array.isArray(requirement.acceptance_criteria) || requirement.acceptance_criteria.length < 2) errors.push(`${requirement.id}: legalább két elfogadási kritérium kötelező`);

  for (const [index, criterion] of requirement.acceptance_criteria.entries()) {
    const expectedId = `${requirement.id}-AC-${String(index + 1).padStart(2, '0')}`;
    if (criterion.id !== expectedId) errors.push(`${requirement.id}: hibás vagy nem sorfolytonos kritérium-ID (${criterion.id})`);
    for (const field of ['given', 'when', 'then']) {
      if (!nonEmpty(criterion[field]) || vague.test(criterion[field])) errors.push(`${criterion.id}: a ${field} mező nem objektív`);
    }
    const verification = criterion.verification || {};
    if (!methods.has(verification.method)) errors.push(`${criterion.id}: hibás ellenőrzési módszer`);
    if (verification.test_case_id !== `TC-${criterion.id}`) errors.push(`${criterion.id}: hibás visszamutató teszteset-ID`);
    if (!automationStatuses.has(verification.automation_status)) errors.push(`${criterion.id}: hibás automatizálási státusz`);
    if (verification.evidence_required !== true) errors.push(`${criterion.id}: a bizonyíték nem kötelező`);
    if (!Array.isArray(verification.test_refs)) errors.push(`${criterion.id}: a test_refs nem tömb`);
    if (verification.automation_status === 'automated' && verification.test_refs.length === 0) errors.push(`${criterion.id}: automatizált kritérium teszthivatkozás nélkül`);
    for (const ref of verification.test_refs || []) {
      const refPath = path.join(root, ref);
      if (!fs.existsSync(refPath)) errors.push(`${criterion.id}: nem létező teszthivatkozás (${ref})`);
      else if (!fs.readFileSync(refPath, 'utf8').includes(requirement.id)) errors.push(`${criterion.id}: a teszt nem hivatkozik vissza a követelmény-ID-ra (${ref})`);
    }
  }
}

if (!unique(allRequirementIds)) errors.push('A követelmény-ID-k nem egyediek');
if (!unique(allAcceptanceIds)) errors.push('Az elfogadásikritérium-ID-k nem egyediek');

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const requirementsCheck = String(packageJson.scripts?.['requirements:check'] || '').trim();
const hasRequirementsCiCommand = requirementsCheck === 'node scripts/validate-requirements.mjs' || requirementsCheck.startsWith('node scripts/validate-requirements.mjs && ');

const checks = [
  { name: 'Egyedi, stabil azonosítók', weight: 1.0, ok: unique(allRequirementIds) && unique(allAcceptanceIds) && catalog.id_policy?.immutable === true && catalog.id_policy?.reuse_forbidden === true },
  { name: 'Atomi követelmény és PDF-forrás', weight: 1.0, ok: catalog.requirements.every((item) => nonEmpty(item.statement) && !vague.test(item.statement) && Number.isInteger(item.source?.page) && nonEmpty(item.source?.section)) },
  { name: 'Given–When–Then elfogadási kritériumok', weight: 2.0, ok: catalog.requirements.every((item) => item.acceptance_criteria.length >= 2 && item.acceptance_criteria.every((criterion) => nonEmpty(criterion.given) && nonEmpty(criterion.when) && nonEmpty(criterion.then) && !vague.test(criterion.then))) },
  { name: 'Ellenőrzési módszer és teszteset-ID', weight: 1.5, ok: catalog.requirements.every((item) => item.acceptance_criteria.every((criterion) => methods.has(criterion.verification.method) && criterion.verification.test_case_id === `TC-${criterion.id}`)) },
  { name: 'Kétirányú nyomonkövetés', weight: 1.5, ok: unique(allAcceptanceIds) && catalog.requirements.every((item) => item.acceptance_criteria.every((criterion) => criterion.id.startsWith(`${item.id}-AC-`) && criterion.verification.test_case_id.endsWith(criterion.id))) },
  { name: 'Prioritás, felelős és életciklus', weight: 1.0, ok: catalog.requirements.every((item) => priorities.has(item.priority) && nonEmpty(item.owner_role) && lifecycleStatuses.has(item.lifecycle_status)) },
  { name: 'Változáskezelés', weight: 1.0, ok: Object.values(catalog.change_control || {}).every((value) => value === true) && fs.existsSync(path.join(root, 'docs/requirements/README.md')) },
  { name: 'Automatikus CI-kapu', weight: 1.0, ok: fs.existsSync(path.join(root, '.github/workflows/requirements-traceability.yml')) && hasRequirementsCiCommand },
];

const matrix = [
  '# Követelmény–teszt nyomonkövetési mátrix',
  '',
  '> Generált fájl. Forrás: `catalog.cjs`. Frissítés: `npm run requirements:matrix`.',
  '',
  `Követelmények: **${catalog.requirements.length}** · Elfogadási kritériumok / tesztesetek: **${allAcceptanceIds.length}**`,
  '',
  '| Követelmény | Terület | PDF | Prioritás | Felelős | Kritériumok / tesztesetek | Automatizálás |',
  '|---|---|---:|---|---|---|---|',
  ...catalog.requirements.map((item) => {
    const criteria = item.acceptance_criteria.map((criterion) => `${criterion.id} → ${criterion.verification.test_case_id}`).join('<br>');
    const automation = [...new Set(item.acceptance_criteria.map((criterion) => criterion.verification.automation_status))].join(', ');
    return `| ${item.id} | ${item.area} | ${item.source.page}. oldal | ${item.priority} | ${item.owner_role} | ${criteria} | ${automation} |`;
  }),
  '',
].join('\n');

if (writeMatrix) fs.writeFileSync(matrixPath, matrix, 'utf8');
else if (!fs.existsSync(matrixPath) || fs.readFileSync(matrixPath, 'utf8') !== matrix) errors.push('A TRACEABILITY.md nincs frissítve; futtasd: npm run requirements:matrix');

const score = checks.reduce((sum, check) => sum + (check.ok ? check.weight : 0), 0);
for (const check of checks) console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.ok ? check.weight.toFixed(1) : '0.0'}/${check.weight.toFixed(1)}`);
console.log(`Követelmények: ${catalog.requirements.length}; elfogadási kritériumok: ${allAcceptanceIds.length}`);
console.log(`Tesztelhetőségi pontszám: ${score.toFixed(1)}/10.0`);

if (errors.length || score !== 10) {
  for (const error of errors) console.error(`ERROR ${error}`);
  process.exitCode = 1;
}
