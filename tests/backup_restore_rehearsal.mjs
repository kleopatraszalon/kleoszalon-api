import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const { Client } = pg;

const source = String(process.env.SOURCE_DATABASE_URL || '').trim();
const restore = String(process.env.RESTORE_DATABASE_URL || '').trim();
const environment = String(process.env.BACKUP_EVIDENCE_ENVIRONMENT || 'github-actions-postgresql17');
const pgClientDockerImage = String(process.env.PG_CLIENT_DOCKER_IMAGE || '').trim();
if (!source || !restore) throw new Error('SOURCE_DATABASE_URL and RESTORE_DATABASE_URL are required');

const evidenceDir = path.resolve('evidence');
fs.mkdirSync(evidenceDir, { recursive: true });
const dumpPath = path.join(evidenceDir, 'kleo-backup.dump');
const started = Date.now();

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, {
  stdio: ['ignore', 'pipe', 'pipe'],
  encoding: 'utf8',
  ...opts,
}).trim();

const dockerPg = (url, shellCommand, extraEnv = {}) => run(
  'docker',
  [
    'run', '--rm', '--network', 'host',
    '-v', `${evidenceDir}:/evidence`,
    '-e', 'PG_TARGET_URL',
    ...Object.keys(extraEnv).flatMap((key) => ['-e', key]),
    pgClientDockerImage,
    'sh', '-lc', shellCommand,
  ],
  {
    env: {
      ...process.env,
      PG_TARGET_URL: url,
      ...extraEnv,
    },
  },
);

const quoteIdent = (value) => `"${String(value).replaceAll('"', '""')}"`;
const quoteLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;

const readCounts = async (client) => {
  const tableResult = await client.query(`
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
    ORDER BY table_schema, table_name
  `);
  if (!tableResult.rows.length) throw new Error('Database has no public base tables');

  const countQuery = tableResult.rows
    .map(({ table_schema, table_name }) =>
      `SELECT ${quoteLiteral(`${table_schema}.${table_name}`)} AS table_name, count(*)::bigint AS row_count FROM ${quoteIdent(table_schema)}.${quoteIdent(table_name)}`
    )
    .join(' UNION ALL ') + ' ORDER BY table_name';

  const countResult = await client.query(countQuery);
  const counts = countResult.rows
    .map(({ table_name, row_count }) => `${table_name}|${String(row_count)}`)
    .join('\n');

  return {
    tableCount: tableResult.rows.length,
    counts,
  };
};

const sourceClient = new Client({
  connectionString: source,
  connectionTimeoutMillis: 30000,
  application_name: 'kleoszalon-backup-evidence-source',
});
const restoreClient = new Client({
  connectionString: restore,
  connectionTimeoutMillis: 30000,
  application_name: 'kleoszalon-backup-evidence-restore',
});

let sourceTransactionOpen = false;
let sourceSnapshot;
let sourceRecoveryPoint;
let sourceState;

try {
  await sourceClient.connect();
  await sourceClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY');
  sourceTransactionOpen = true;

  const snapshotResult = await sourceClient.query(`
    SELECT pg_export_snapshot() AS snapshot_id,
           transaction_timestamp() AS recovery_point
  `);
  sourceSnapshot = String(snapshotResult.rows[0]?.snapshot_id || '').trim();
  sourceRecoveryPoint = snapshotResult.rows[0]?.recovery_point;
  if (!sourceSnapshot) throw new Error('Unable to export source PostgreSQL snapshot');

  // These counts and pg_dump below are intentionally bound to the same exported snapshot.
  // This prevents legitimate production writes during the backup from causing false mismatches.
  sourceState = await readCounts(sourceClient);

  if (pgClientDockerImage) {
    dockerPg(
      source,
      'pg_dump --format=custom --no-owner --no-acl --snapshot="$PG_SNAPSHOT" --file=/evidence/kleo-backup.dump "$PG_TARGET_URL"',
      { PG_SNAPSHOT: sourceSnapshot },
    );
  } else {
    run('pg_dump', [
      '--format=custom',
      '--no-owner',
      '--no-acl',
      `--snapshot=${sourceSnapshot}`,
      '--file', dumpPath,
      source,
    ]);
  }

  await sourceClient.query('COMMIT');
  sourceTransactionOpen = false;
} catch (error) {
  if (sourceTransactionOpen) {
    try { await sourceClient.query('ROLLBACK'); } catch { /* best effort */ }
  }
  throw error;
} finally {
  await sourceClient.end().catch(() => {});
}

const dumpBytes = fs.statSync(dumpPath).size;
if (dumpBytes <= 0) throw new Error('Backup dump is empty');

// RESTORE_DATABASE_URL points to an isolated disposable database prepared by the workflow.
if (pgClientDockerImage) {
  dockerPg(
    restore,
    'pg_restore --no-owner --no-acl --exit-on-error --dbname "$PG_TARGET_URL" /evidence/kleo-backup.dump',
  );
} else {
  run('pg_restore', ['--no-owner', '--no-acl', '--exit-on-error', '--dbname', restore, dumpPath]);
}

await restoreClient.connect();
let restoredState;
try {
  restoredState = await readCounts(restoreClient);
} finally {
  await restoreClient.end().catch(() => {});
}

if (sourceState.tableCount !== restoredState.tableCount) {
  throw new Error(`Table-count mismatch after restore: source=${sourceState.tableCount} restored=${restoredState.tableCount}`);
}
if (sourceState.counts !== restoredState.counts) {
  throw new Error('Snapshot-consistent row-count check failed after restore');
}

const rtoSeconds = Math.round((Date.now() - started) / 100) / 10;
const evidence = {
  schema_version: '1.1.0',
  build_ref: process.env.GITHUB_SHA || 'local',
  environment,
  workflow: 'backup-restore-evidence',
  postgres_major: 17,
  pg_client_mode: pgClientDockerImage ? `docker:${pgClientDockerImage}` : 'local',
  result: 'passed',
  source_recovery_point: sourceRecoveryPoint instanceof Date
    ? sourceRecoveryPoint.toISOString()
    : String(sourceRecoveryPoint || ''),
  restored_at: new Date().toISOString(),
  measured_rto_seconds: rtoSeconds,
  public_table_count: sourceState.tableCount,
  dump_bytes: dumpBytes,
  consistency: {
    exported_snapshot: true,
    dump_uses_exported_snapshot: true,
    table_count_equal: true,
    row_counts_equal: true,
  },
  criteria: [
    { criterion_id: 'KLEO-NFR-BCK-001-AC-01', result: 'passed', test_ref: 'tests/backup_restore_rehearsal.mjs' },
    { criterion_id: 'KLEO-NFR-BCK-001-AC-02', result: 'passed', test_ref: '.github/workflows/backup-restore-evidence.yml' },
  ],
};
fs.writeFileSync(path.join(evidenceDir, 'requirements-evidence-backup-restore.json'), JSON.stringify(evidence, null, 2));
console.log(`BACKUP_RESTORE_EVIDENCE_OK tables=${sourceState.tableCount} rto_seconds=${rtoSeconds} dump_bytes=${dumpBytes} snapshot_consistent=true pg_client=${evidence.pg_client_mode}`);
