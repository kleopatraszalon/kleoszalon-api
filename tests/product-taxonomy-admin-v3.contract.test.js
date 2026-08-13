const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

const admin = read('src/routes/productTaxonomyAdmin.ts');
const importRouter = read('src/routes/productsImport.ts');

test('taxonomy review routes are mounted under products taxonomy', () => {
  assert.match(importRouter, /router\.use\("\/taxonomy",\s*productTaxonomyAdminRouter\)/);
  assert.match(admin, /router\.get\("\/review"/);
  assert.match(admin, /router\.get\("\/review\/summary"/);
  assert.match(admin, /router\.patch\("\/review\/:id"/);
  assert.match(admin, /router\.get\("\/review\/:id\/history"/);
});

test('taxonomy review writes are management-only and validate hierarchy', () => {
  assert.match(admin, /requireManagement/);
  assert.match(admin, /c\.product_group_id/);
  assert.match(admin, /COALESCE\(c\.is_active,true\)=true/);
  assert.match(admin, /COALESCE\(g\.is_active,true\)=true/);
});

test('manual taxonomy decisions are durable and auditable', () => {
  assert.match(admin, /CREATE TABLE IF NOT EXISTS product_taxonomy_overrides/);
  assert.match(admin, /taxonomy_source='manual'/);
  assert.match(admin, /taxonomy_confidence=1/);
  assert.match(admin, /INSERT INTO product_taxonomy_overrides/);
  assert.match(admin, /reviewed_by/);
  assert.match(admin, /review_note/);
});

test('review list exposes low confidence fallback and unclassified reasons', () => {
  assert.match(admin, /is_unclassified/);
  assert.match(admin, /is_low_confidence/);
  assert.match(admin, /is_fallback/);
  assert.match(admin, /taxonomy_confidence/);
  assert.match(admin, /source_category_name/);
});
