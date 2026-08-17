'use strict';
process.env.TS_NODE_PROJECT = process.env.TS_NODE_PROJECT || 'tsconfig.server.json';
require('ts-node/register/transpile-only');
const test=require('node:test');
const assert=require('node:assert/strict');
const {normalizeNameField}=require('../src/utils/nameNormalization.ts');

// KLEO-GEN-UI-001 / KLEO-GEN-UI-001-AC-01
test('preserves leading whitespace and uppercases the first non-whitespace character',()=>{
  assert.equal(normalizeNameField('  kovács'),'  Kovács');
  assert.equal(normalizeNameField('\tárvai'),'\tÁrvai');
});

// KLEO-GEN-UI-001 / KLEO-GEN-UI-001-AC-02
test('empty and whitespace-only values remain unchanged',()=>{
  assert.equal(normalizeNameField(''),'');
  assert.equal(normalizeNameField('   '),'   ');
  assert.equal(normalizeNameField('\t  '),'\t  ');
});
