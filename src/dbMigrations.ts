import crypto from "crypto";
import fs from "fs";
import path from "path";
import db from "./db";
import { syncKleoshopCatalog } from "./catalog/syncKleoshopCatalog";

const MIGRATION_LOCK_KEY_A = 20260819;
const MIGRATION_LOCK_KEY_B = 1;
const MIGRATION_STATEMENT_TIMEOUT_MS = Math.max(30000, Number(process.env.PG_MIGRATION_STATEMENT_TIMEOUT_MS ?? 300000));
const MIGRATION_LOCK_TIMEOUT_MS = Math.max(5000, Number(process.env.PG_MIGRATION_LOCK_TIMEOUT_MS ?? 60000));
const MIGRATION_FAILURE_MODE = String(
  process.env.MIGRATION_FAILURE_MODE || (process.env.NODE_ENV === "production" ? "readiness" : "strict"),
).trim().toLowerCase();

function sha256(content: string) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function resolveMigrationDir() {
  const candidates = [
    path.join(__dirname, "migrations"),
    path.join(process.cwd(), "dist", "migrations"),
    path.join(process.cwd(), "src", "migrations"),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(`Migration directory not found. Checked: ${candidates.join(", ")}`);
  }
  return found;
}

async function configureMigrationSession(client: any) {
  await client.query("SELECT set_config('statement_timeout',$1,false)", [`${MIGRATION_STATEMENT_TIMEOUT_MS}ms`]);
  await client.query("SELECT set_config('lock_timeout',$1,false)", [`${MIGRATION_LOCK_TIMEOUT_MS}ms`]);
}

async function ensureMigrationLedger(client: any) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      description text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query(`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum_sha256 text`);
}

function isMigrationIntegrityFailure(error: unknown) {
  const message = String((error as any)?.message || error || "");
  return message.includes("Migration checksum mismatch") || message.includes("recorded without a checksum");
}

export async function runMigrations() {
  const client = await db.connect();
  let locked = false;
  try {
    await configureMigrationSession(client);
    console.log(`[migration] session timeout=${MIGRATION_STATEMENT_TIMEOUT_MS}ms lock_timeout=${MIGRATION_LOCK_TIMEOUT_MS}ms`);
    await client.query("SELECT pg_advisory_lock($1,$2)", [MIGRATION_LOCK_KEY_A, MIGRATION_LOCK_KEY_B]);
    locked = true;
    await ensureMigrationLedger(client);

    const migrationDir = resolveMigrationDir();
    const files = fs.readdirSync(migrationDir)
      .filter((name) => /^\d+.*\.sql$/i.test(name))
      .sort((a, b) => a.localeCompare(b));

    if (!files.length) {
      throw new Error(`No versioned migrations found in ${migrationDir}`);
    }

    for (const file of files) {
      const version = file.replace(/\.sql$/i, "");
      const fullPath = path.join(migrationDir, file);
      const sql = fs.readFileSync(fullPath, "utf8");
      const checksum = sha256(sql);
      const existing = await client.query(
        `SELECT checksum_sha256 FROM schema_migrations WHERE version=$1`,
        [version],
      );

      if (existing.rowCount) {
        const recorded = String(existing.rows[0]?.checksum_sha256 || "").trim();
        if (recorded && recorded !== checksum) {
          throw new Error(
            `Migration checksum mismatch for ${file}. Applied migrations are immutable; create a new migration instead.`,
          );
        }
        if (!recorded) {
          throw new Error(
            `Migration ${file} is recorded without a checksum. Refusing to assume equivalence; reconcile the ledger explicitly.`,
          );
        }
        console.log(`[migration] already applied: ${file}`);
        continue;
      }

      console.log(`[migration] applying: ${file}`);
      const startedAt = Date.now();
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO schema_migrations(version,description,checksum_sha256) VALUES($1,$2,$3)`,
          [version, `Versioned migration ${file}`, checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        console.error(`[migration] failed: ${file} after ${Date.now() - startedAt}ms`);
        throw error;
      }
      console.log(`[migration] applied: ${file} (${Date.now() - startedAt}ms)`);
    }

    // The storefront catalog is version-controlled and verified before merge.
    // Sync it under the same global migration lock so two Render instances can
    // never race product/category creation during a rolling production deploy.
    const catalogStats = await syncKleoshopCatalog(client);
    console.log(
      `[migration] Kleoshop catalog ready: total=${catalogStats.total}, inserted=${catalogStats.inserted}, ` +
      `updated=${catalogStats.updated}, matched_by_name=${catalogStats.matchedByName}`,
    );
  } finally {
    if (locked) {
      await client.query("SELECT pg_advisory_unlock($1,$2)", [MIGRATION_LOCK_KEY_A, MIGRATION_LOCK_KEY_B]).catch(() => undefined);
    }
    client.release();
  }
}

async function main() {
  try {
    await runMigrations();
    console.log("Database migrations complete.");
  } catch (error) {
    console.error("Database migration failed:", error);
    const integrityFailure = isMigrationIntegrityFailure(error);
    if (MIGRATION_FAILURE_MODE === "strict" || integrityFailure) {
      process.exitCode = 1;
    } else {
      console.error(
        "[migration] non-integrity failure deferred to runtime readiness; API startup may continue in fail-closed readiness mode.",
      );
      process.exitCode = 0;
    }
  } finally {
    await db.end().catch(() => undefined);
  }
}

if (require.main === module) {
  void main();
}
