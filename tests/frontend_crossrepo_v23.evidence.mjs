import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';

// KLEO-GEN-AUTH-001 / KLEO-GEN-AUTH-001-AC-01
// KLEO-GEN-AUTH-001 / KLEO-GEN-AUTH-001-AC-02
const frontend=path.resolve(process.argv[2]||'frontend');
const api=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const env={...process.env,CI:'true'};

execFileSync('npm',['test','--','--watchAll=false','--runInBand','--runTestsByPath','src/AuthSessionIdleLogout.test.ts'],{cwd:frontend,stdio:'inherit',env});
execFileSync(process.execPath,['--test','tests/idle_auth_v23.contract.test.js'],{cwd:api,stdio:'inherit',env});

const session=fs.readFileSync(path.join(frontend,'src/utils/authSession.ts'),'utf8');
const layout=fs.readFileSync(path.join(frontend,'src/layouts/AppLayout.tsx'),'utf8');
assert.match(session,/IDLE_TIMEOUT_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/,'idle timeout must remain exactly 300 seconds');
assert.match(layout,/Date\.now\(\) - currentLastActivity\(\)/,'idle elapsed time must be evaluated from last activity');
assert.match(layout,/elapsed >= IDLE_TIMEOUT_MS/,'elapsed 300 seconds must expire the session');
assert.match(layout,/registerActivity[\s\S]*markSessionActivity\(now\)[\s\S]*schedule\(\)/,'allowed activity must persist the timestamp and reschedule the timer');
for(const event of ['pointerdown','keydown','touchstart','scroll'])assert.ok(layout.includes(`addEventListener("${event}", registerActivity`),`${event} must reset idle activity`);
assert.match(layout,/verifyThenRegisterActivity[\s\S]*elapsed >= IDLE_TIMEOUT_MS[\s\S]*registerActivity\(\)/,'focus/visibility must not revive an already expired session');
assert.match(layout,/navigate\(reason === "idle" \? "\/login\?reason=idle" : "\/login"/,'idle expiry must navigate to logged-out state');

console.log('PASS KLEO v23 idle-session cross-repo acceptance evidence.');
