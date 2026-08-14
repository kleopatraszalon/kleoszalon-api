const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = p => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

test('Stage18 social hub is mounted under management newsletters route', () => {
  const source = read('src/routes/newsletters.ts');
  assert.match(source, /import socialPublishingRouter from "\.\/socialPublishing"/);
  assert.match(source, /router\.use\("\/social", socialPublishingRouter\)/);
});

test('Stage18 supports Facebook, Instagram and TikTok with scheduling and audit state', () => {
  const route = read('src/routes/socialPublishing.ts');
  assert.match(route, /social_campaigns/);
  assert.match(route, /social_publications/);
  assert.match(route, /\/campaigns\/:id\/schedule/);
  assert.match(route, /\/campaigns\/:id\/publish/);
  assert.match(route, /\/publications\/:id\/retry/);
  assert.match(route, /setInterval/);
  assert.match(route, /fetchTikTokPublishStatus/);
});

test('social credentials stay server-side in environment configuration', () => {
  const config = read('src/social/config.ts');
  assert.match(config, /META_PAGE_ACCESS_TOKEN/);
  assert.match(config, /META_IG_ACCESS_TOKEN/);
  assert.match(config, /TIKTOK_ACCESS_TOKEN/);
  assert.match(config, /publicSocialAccountStatus/);
  assert.doesNotMatch(config, /accessToken:\s*["'][^"']{16,}["']/);
});

test('Meta and TikTok adapters use official publishing flows', () => {
  const meta = read('src/social/metaPublisher.ts');
  const tiktok = read('src/social/tiktokPublisher.ts');
  assert.match(meta, /\/photos/);
  assert.match(meta, /\/media_publish/);
  assert.match(meta, /media_type = "REELS"/);
  assert.match(tiktok, /\/v2\/post\/publish\/creator_info\/query\//);
  assert.match(tiktok, /\/v2\/post\/publish\/video\/init\//);
  assert.match(tiktok, /\/v2\/post\/publish\/content\/init\//);
  assert.match(tiktok, /consent_confirmed/);
});
