'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8');

const appHa = read('ha-application-failover-evidence.yml');
const dbHa = read('ha-database-failover-evidence.yml');
const rollback = read('release-rollback-evidence.yml');

test('application HA workflow measures 99.9 percent availability and verifies accepted writes', () => {
  assert.ok(appHa.includes('KLEO-NFR-HA-001-AC-01'));
  assert.ok(appHa.includes('pct<99.9'));
  assert.ok(appHa.includes('HA_APPLICATION_WRITE_PROBE_URL'));
  assert.ok(appHa.includes('Idempotency-Key'));
  assert.ok(appHa.includes('lost_accepted_writes:0'));
  assert.ok(appHa.includes('Fail closed when HA harness is not configured'));
});

test('database HA workflow measures RTO and RPO and checks acknowledged writes', () => {
  assert.ok(dbHa.includes('KLEO-NFR-HA-001-AC-02'));
  assert.ok(dbHa.includes('approved_rto_seconds'));
  assert.ok(dbHa.includes('approved_rpo_seconds'));
  assert.ok(dbHa.includes('Verify every acknowledged probe write survived failover'));
  assert.ok(dbHa.includes('lost_acknowledged_writes:0'));
  assert.ok(dbHa.includes('Fail closed when database HA harness is not configured'));
});

test('rollback workflow requires observed candidate failure, RTO recovery and zero data loss', () => {
  assert.ok(rollback.includes('KLEO-NFR-REL-001-AC-02'));
  assert.ok(rollback.includes('Confirm candidate smoke failure'));
  assert.ok(rollback.includes('Wait for known-good service within approved RTO'));
  assert.ok(rollback.includes('Verify accepted pre-rollback data survived'));
  assert.ok(rollback.includes('data_loss:false'));
  assert.ok(rollback.includes('Fail closed when runtime evidence secrets are absent'));
});
