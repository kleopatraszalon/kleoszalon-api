import {execFileSync} from 'node:child_process';
import path from 'node:path';

// KLEO-NFR-RES-001 / KLEO-NFR-RES-001-AC-02
// KLEO-GEN-I18N-001 / KLEO-GEN-I18N-001-AC-01
// KLEO-GEN-I18N-001 / KLEO-GEN-I18N-001-AC-02
const frontend=path.resolve(process.argv[2]||'frontend');
const env={...process.env,CI:'true'};
execFileSync('npm',['test','--','--watchAll=false','--runInBand','--runTestsByPath','src/NetworkResilience.test.ts','src/LanguagePersistence.test.tsx'],{cwd:frontend,stdio:'inherit',env});
console.log('PASS KLEO v20 frontend cross-repo acceptance evidence.');
