import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';

// KLEO-GEN-AUTH-001 / KLEO-GEN-AUTH-001-AC-01
// Owner policy: the five-minute inactivity rule is an admin screen lock only.
// Non-admin users must not be logged out or locked because of inactivity.
const frontend=path.resolve(process.argv[2]||'frontend');
const api=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const env={...process.env,CI:'true'};

execFileSync('npm',['test','--','--watchAll=false','--runInBand','--runTestsByPath','src/AuthSessionIdleLogout.test.ts'],{cwd:frontend,stdio:'inherit',env});
execFileSync(process.execPath,['--test','tests/idle_auth_v23.contract.test.js'],{cwd:api,stdio:'inherit',env});

const session=fs.readFileSync(path.join(frontend,'src/utils/authSession.ts'),'utf8');
const guard=fs.readFileSync(path.join(frontend,'src/hooks/useSessionIdleGuard.ts'),'utf8');
const layout=fs.readFileSync(path.join(frontend,'src/layouts/AppLayout.tsx'),'utf8');
assert.match(session,/ADMIN_IDLE_LOCK_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/,'admin lock timeout must remain exactly 300 seconds');
assert.match(guard,/if \(!isAdmin\)[\s\S]*clearAdminIdleActivity\(\)[\s\S]*return;/,'non-admin sessions must exit before any idle timer is created');
assert.doesNotMatch(guard,/logout\("idle"\)/,'inactivity must never invoke logout');
assert.match(guard,/elapsed >= ADMIN_IDLE_LOCK_MS[\s\S]*setLocked\(true\)/,'admin inactivity must lock instead of logout');
assert.match(guard,/registerActivity[\s\S]*markSessionActivity\(now\)[\s\S]*schedule\(\)/,'admin activity must persist the timestamp and reschedule the lock timer');
for(const event of ['pointerdown','keydown','touchstart','scroll'])assert.ok(guard.includes(`addEventListener("${event}", registerActivity`),`${event} must reset admin lock activity`);
assert.match(layout,/useSessionIdleGuard\(user\?\.role, user\?\.email\)/,'layout must provide the current role to the idle policy');
assert.match(layout,/idleGuard\.locked[\s\S]*<AdminIdleLock/,'admin idle state must render a lock screen');

console.log('PASS KLEO v23 admin-only idle-lock cross-repo acceptance evidence.');