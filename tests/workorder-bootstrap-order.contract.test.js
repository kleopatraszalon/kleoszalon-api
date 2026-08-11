const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const workflow=fs.readFileSync(path.join(process.cwd(),'src/workorders/ensureWorkOrderWorkflow.ts'),'utf8');
const finance=fs.readFileSync(path.join(process.cwd(),'src/finance/ensureFinanceNav.ts'),'utf8');

test('legacy document_status CHECK repair runs before the first work_orders UPDATE',()=>{
  const drop=workflow.indexOf("runStage(pool,'drop_legacy_document_status_checks'");
  const sync=workflow.indexOf("runStage(pool,'sync_timestamps'");
  const normalize=workflow.indexOf("runStage(pool,'normalize_document_status'");
  assert.ok(drop>=0,'legacy CHECK repair stage missing');
  assert.ok(sync>drop,'timestamp synchronization must run after legacy CHECK removal');
  assert.ok(normalize>sync,'document status normalization must run after safe timestamp synchronization');
});

test('workflow bootstrap failures expose a precise substage through existing diagnostics',()=>{
  assert.match(workflow,/workOrderBootstrapSubstage=substage/);
  assert.match(finance,/this\.stage=substage\?`\$\{stage\}:\$\{substage\}`:stage/);
  assert.match(finance,/this\.constraint=cause\?\.constraint/);
});
