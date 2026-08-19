const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const blockedPathPatterns = [
  /(^|\/)\.env$/i,
  /(^|\/)\.env\.(?!example$|sample$|template$).+/i,
  /(^|\/)(id_rsa|id_ed25519)$/i,
  /\.(pem|key|p12|pfx|jks)$/i,
  /(^|\/)secrets\.local\./i,
  /\.(secret|secrets)$/i,
];

const blockedRootArtifactPatterns = [
  /^[^/]+\.(lnk|exe|zip)$/i,
  /^desktop\.ini$/i,
];
const blockedExactRootArtifacts = new Set([
  '({',
  'm.parent_id',
  'nvm',
  'Új Szöveges dokumentum.txt',
]);
const blockedTrackedDirectories = ['node_modules/', 'dist/'];

const contentPatterns = [
  { name: 'private key material', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'GitHub classic token', regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'GitHub fine-grained token', regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: 'AWS access key', regex: /\bAKIA[0-9A-Z]{16}\b/ },
];

const postgresUrlPattern = /postgres(?:ql)?:\/\/[^\s"'`<>]+/gi;
const localHosts = new Set(['localhost', '127.0.0.1', '::1', 'postgres', 'db', 'database']);
const placeholderValues = new Set(['postgres', 'user', 'username', 'password', 'pass', 'secret', 'test', 'example', 'changeme', 'change-me']);

function suspiciousPostgresUrl(raw) {
  try {
    const url = new URL(raw);
    const host = String(url.hostname || '').toLowerCase();
    const user = decodeURIComponent(url.username || '').toLowerCase();
    const pass = decodeURIComponent(url.password || '').toLowerCase();
    if (!user || !pass) return false;
    if (localHosts.has(host) || host.endsWith('.local')) return false;
    if (placeholderValues.has(user) || placeholderValues.has(pass)) return false;
    if (/\$\{|<[^>]+>|\{\{/.test(raw)) return false;
    return true;
  } catch {
    return false;
  }
}

const failures = [];
let checked = 0;
for (const file of tracked) {
  if (blockedTrackedDirectories.some(prefix => file.startsWith(prefix))) {
    failures.push(`${file}: generated dependency/build output must not be tracked`);
    continue;
  }
  if (blockedRootArtifactPatterns.some(pattern => pattern.test(file)) || blockedExactRootArtifacts.has(file)) {
    failures.push(`${file}: blocked root-level local/binary artifact`);
    continue;
  }
  if (blockedPathPatterns.some(pattern => pattern.test(file))) {
    failures.push(`${file}: blocked secret-bearing filename`);
    continue;
  }

  let stat;
  try { stat = fs.statSync(file); } catch { continue; }
  if (!stat.isFile() || stat.size > 1024 * 1024) continue;

  let content;
  try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
  if (content.includes('\u0000')) continue;
  checked += 1;

  for (const pattern of contentPatterns) {
    if (pattern.regex.test(content)) failures.push(`${file}: ${pattern.name}`);
  }

  const postgresUrls = content.match(postgresUrlPattern) || [];
  if (postgresUrls.some(suspiciousPostgresUrl)) {
    failures.push(`${file}: non-placeholder credential-bearing PostgreSQL URL`);
  }
}

if (failures.length) {
  console.error('Repository security/hygiene guard FAILED. Remove or replace the following tracked material:');
  for (const failure of [...new Set(failures)]) console.error(` - ${failure}`);
  process.exit(1);
}

console.log(`Repository security/hygiene guard PASS (${checked} project files checked).`);
