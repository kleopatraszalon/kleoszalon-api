import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const source = String(process.env.SOURCE_DATABASE_URL || '').trim();
const restore = String(process.env.RESTORE_DATABASE_URL || '').trim();
const environment = String(process.env.BACKUP_EVIDENCE_ENVIRONMENT || 'github-actions-postgresql17');
if (!source || !restore) throw new Error('SOURCE_DATABASE_URL and RESTORE_DATABASE_URL are required');

const evidenceDir = path.resolve('evidence');
fs.mkdirSync(evidenceDir, { recursive: true });
const dumpPath = path.join(evidenceDir, 'kleo-backup.dump');
const started = Date.now();
const sourcePoint = new Date().toISOString();

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts }).trim();
const scalar = (url, sql) => run('psql', [url, '-Atqc', sql]);

// Never print connection strings. The dump is custom-format so restore failures are explicit.
run('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--file', dumpPath, source]);
const dumpBytes = fs.statSync(dumpPath).size;
if (dumpBytes <= 0) throw new Error('Backup dump is empty');

// RESTORE_DATABASE_URL points to an isolated disposable database prepared by the workflow.
run('pg_restore', ['--no-owner', '--no-acl', '--exit-on-error', '--dbname', restore, dumpPath]);

const sourceTables = Number(scalar(source, `SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`));
const restoredTables = Number(scalar(restore, `SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`));
if (!Number.isFinite(sourceTables) || sourceTables < 1) throw new Error('Source database has no public base tables');
if (sourceTables !== restoredTables) throw new Error(`Table-count mismatch after restore: source=${sourceTables} restored=${restoredTables}`);

// Compare row counts for every table where a simple count is permitted. This is deliberately
// generated inside PostgreSQL so table names are quoted correctly and secrets never enter logs.
const countSql = `SELECT string_agg(format('SELECT %L table_name,count(*)::bigint row_count FROM %I.%I',table_name,table_schema,table_name),' UNION ALL ' ORDER BY table_name) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`;
const sourceUnion = scalar(source, countSql);
const restoreUnion = scalar(restore, countSql);
if (!sourceUnion || !restoreUnion) throw new Error('Unable to build consistency row-count query');
const sourceCounts = scalar(source, sourceUnion + ' ORDER BY table_name');
const restoreCounts = scalar(restore, restoreUnion + ' ORDER BY table_name');
if (sourceCounts !== restoreCounts) throw new Error('Row-count consistency check failed after restore');

const rtoSeconds = Math.round((Date.now() - started) / 100) / 10;
const evidence = {
  schema_version: '1.0.0',
  build_ref: process.env.GITHUB_SHA || 'local',
  environment,
  workflow: 'backup-restore-evidence',
  postgres_major: 17,
  result: 'passed',
  source_recovery_point: sourcePoint,
  restored_at: new Date().toISOString(),
  measured_rto_seconds: rtoSeconds,
  public_table_count: sourceTables,
  dump_bytes: dumpBytes,
  consistency: { table_count_equal: true, row_counts_equal: true },
  criteria: [
    { criterion_id: 'KLEO-NFR-BCK-001-AC-01', result: 'passed', test_ref: 'tests/backup_restore_rehearsal.mjs' },
    { criterion_id: 'KLEO-NFR-BCK-001-AC-02', result: 'passed', test_ref: '.github/workflows/backup-restore-evidence.yml' }
  ]
};
fs.writeFileSync(path.join(evidenceDir, 'requirements-evidence-backup-restore.json'), JSON.stringify(evidence, null, 2));
console.log(`BACKUP_RESTORE_EVIDENCE_OK tables=${sourceTables} rto_seconds=${rtoSeconds} dump_bytes=${dumpBytes}`);

// P0 production-evidence trigger: no runtime behavior change.
