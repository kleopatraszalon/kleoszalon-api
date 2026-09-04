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
const hook=fs.readFileSync(path.join(frontend,'src/hooks/useSessionIdleGuard.ts'),'utf8');
const layout=fs.readFileSync(path.join(frontend,'src/layouts/AppLayout.tsx'),'utf8');
const lock=fs.readFileSync(path.join(frontend,'src/components/AdminIdleLock.tsx'),'utf8');
assert.match(session,/IDLE_TIMEOUT_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/,'admin lock timeout must remain exactly 300 seconds');
assert.match(hook,/ADMIN_ROLES/,'idle policy must explicitly identify admin roles');
assert.match(hook,/if \(!isAdmin\)[\s\S]*localStorage\.removeItem\(LAST_ACTIVITY_KEY\)[\s\S]*return;/,'non-admin users must have no five-minute idle timer');
assert.match(hook,/elapsed >= IDLE_TIMEOUT_MS[\s\S]*setLocked\(true\)/,'admin idle expiry must lock instead of logout');
assert.doesNotMatch(hook,/elapsed >= IDLE_TIMEOUT_MS[\s\S]{0,100}logout\("idle"\)/,'admin idle expiry must not auto-logout');
assert.match(hook,/fetch\(withBase\("login"\)/,'admin unlock must re-authenticate on the server');
assert.match(hook,/logout\("lock_failed"\)/,'failed admin password must terminate the locked session');
assert.match(layout,/idleGuard\.locked[\s\S]*AdminIdleLock/,'layout must render the blocking admin lock overlay');
assert.match(lock,/aria-modal="true"/,'admin lock must be modal');

console.log('PASS KLEO v23 admin-only idle-lock cross-repo acceptance evidence.');
