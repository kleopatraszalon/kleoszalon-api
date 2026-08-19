const fs = require('fs');
const path = require('path');

test('P0 secret rotation evidence requires complete provider-side attestation and post-rotation health', () => {
  const workflow = fs.readFileSync(path.join(process.cwd(), '.github/workflows/security-secret-rotation-evidence.yml'), 'utf8');
  for (const required of [
    'database_rotated',
    'smtp_rotated',
    'jwt_rotated',
    'imap_credentials_reviewed',
    'external_api_credentials_reviewed',
    'application_crypto_keys_reviewed',
    'other_exposed_credentials_reviewed',
    'node scripts/security-secret-leak-guard.js',
    '/api/health/ready',
    "issue_number=62",
    'No secret values are stored in this evidence.',
  ]) {
    expect(workflow).toContain(required);
  }
});
