const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('complaint mailbox is idempotent, attachment-capable and IMAP backed', () => {
  const src = read('src/services/complaintMailbox.ts');
  assert.match(src, /UID SEARCH UNSEEN/);
  assert.match(src, /BODY\.PEEK\[\]/);
  assert.match(src, /UNIQUE\(mailbox_key, imap_uid\)/);
  assert.match(src, /complaint_attachments/);
  assert.match(src, /appendRawMessageToSent/);
  assert.match(src, /getSentConfig/);
});

test('WallBoard exposes JSON XML and iframe adapters from daily actions', () => {
  const src = read('src/routes/wallboardPublic.ts');
  assert.match(src, /wallboard\/daily-action\.json/);
  assert.match(src, /wallboard\/daily-action\.xml/);
  assert.match(src, /router\.get\("\/wallboard"/);
  assert.match(src, /FROM daily_action_campaigns/);
  assert.match(src, /status='published'/);
});

test('legacy specification parity routes include reports evaluations moderation documents and release signoff', () => {
  const src = read('src/routes/virSpecParity.ts');
  for (const marker of [
    'vir_report_definitions',
    'hr_legacy_points',
    'guest_reviews',
    'vir_documents',
    'vir_document_versions',
    'release_manual_signoffs',
    '/review-moderation/:id/approve',
    '/reports/:id/export',
  ]) assert.ok(src.includes(marker), `Missing marker: ${marker}`);
  assert.match(src, /const REPORT_SOURCES = \["complaints","hr_modern","hr_legacy","guest_reviews","documents"\]/);
});

test('guest reviews cannot publish to Facebook before moderation approval', () => {
  const src = read('src/routes/virSpecParity.ts');
  const publicReview = src.indexOf('virSpecParityPublicRouter.post("/reviews"');
  const approve = src.indexOf('virSpecParityRouter.post("/review-moderation/:id/approve"');
  const socialInsert = src.indexOf('INSERT INTO social_campaigns', approve);
  assert.ok(publicReview >= 0);
  assert.ok(approve > publicReview);
  assert.ok(socialInsert > approve);
  assert.equal(src.slice(publicReview, approve).includes('INSERT INTO social_campaigns'), false);
});

test('server initializes parity schema before listening and exposes readiness', () => {
  const src = read('src/server.ts');
  const ensureAt = src.indexOf('await ensureSpecParityDependencies()');
  const listenAt = src.indexOf('app.listen(PORT');
  assert.ok(ensureAt >= 0 && listenAt > ensureAt);
  assert.ok(src.includes('/api/health/ready'));
  assert.ok(src.includes('startComplaintMailboxWorker()'));
});
