const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

test('generated dependency and build directories are not tracked', () => {
  const tracked = trackedFiles();
  assert.equal(tracked.some((file) => file.startsWith('node_modules/')), false, 'node_modules must not be tracked');
  assert.equal(tracked.some((file) => file.startsWith('dist/')), false, 'dist must not be tracked');
});

test('root-level local binary/archive artifacts are not tracked', () => {
  const tracked = trackedFiles();
  const forbiddenPattern = /^[^/]+\.(lnk|exe|zip)$/i;
  const offenders = tracked.filter((file) => forbiddenPattern.test(file) || /^desktop\.ini$/i.test(file));
  assert.deepEqual(offenders, []);
});

test('known accidental empty root files are not tracked', () => {
  const tracked = new Set(trackedFiles());
  for (const file of ['({', 'm.parent_id', 'nvm', 'Új Szöveges dokumentum.txt']) {
    assert.equal(tracked.has(file), false, `${file} must not be tracked`);
  }
});

test('gitignore and security guard prevent repository artifact regression', () => {
  const gitignore = fs.readFileSync('.gitignore', 'utf8');
  for (const marker of ['/*.lnk', '/*.exe', '/*.zip', '/desktop.ini']) {
    assert.ok(gitignore.includes(marker), `missing .gitignore marker ${marker}`);
  }

  const guard = fs.readFileSync('scripts/security-secret-leak-guard.js', 'utf8');
  assert.match(guard, /blockedRootArtifactPatterns/);
  assert.match(guard, /blockedTrackedDirectories/);
  assert.match(guard, /node_modules\//);
  assert.match(guard, /dist\//);
});
