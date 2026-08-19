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

const contentPatterns = [
  { name: 'private key material', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'GitHub classic token', regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'GitHub fine-grained token', regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: 'AWS access key', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'credential-bearing PostgreSQL URL', regex: /postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]+@[^\s]+/i },
];

const failures = [];
for (const file of tracked) {
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

  for (const pattern of contentPatterns) {
    if (pattern.regex.test(content)) failures.push(`${file}: ${pattern.name}`);
  }
}

if (failures.length) {
  console.error('Secret leak guard FAILED. Remove or replace the following tracked material:');
  for (const failure of [...new Set(failures)]) console.error(` - ${failure}`);
  process.exit(1);
}

console.log(`Secret leak guard PASS (${tracked.length} tracked files checked).`);
