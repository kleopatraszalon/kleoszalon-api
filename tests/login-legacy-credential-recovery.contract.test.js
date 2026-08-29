const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "dbMigrations.ts"), "utf8");

test("startup migration upgrades legacy plaintext credentials without logging secrets", () => {
  assert.match(source, /upgradeLegacyPasswordHashes/);
  assert.match(source, /bcrypt\.hash\(plaintextCandidate, 12\)/);
  assert.match(source, /UPDATE \$\{tableName\} SET password_hash=\$1 WHERE id=\$2/);
  assert.match(source, /unsupported hash format/);
  assert.doesNotMatch(source, /console\.(?:log|info|warn|error)\([^\n]*plaintextCandidate/);
});

test("supported bcrypt and PBKDF2 credentials are left untouched", () => {
  assert.match(source, /\^\\\$2\[aby\]/);
  assert.match(source, /credential\.startsWith\("pbkdf2\$"\)/);
});
