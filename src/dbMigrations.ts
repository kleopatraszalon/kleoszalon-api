import fs from "fs";
import path from "path";
import crypto from "crypto";
import db from "./db";

const MIGRATION_DIR = path.join(process.cwd(), "src", "migrations");
const MIGRATION_LOCK_KEY_A = 20260818;
const MIGRATION_LOCK_KEY_B = 1;

function sha256(content: string) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

async function ensureMigrationTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_name text PRIMARY KEY,
      checksum_sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export async function runMigrations() {
  const client = await db.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock($1,$2)", [MIGRATION_LOCK_KEY_A, MIGRATION_LOCK_KEY_B]);
    locked = true;
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        migration_name text PRIMARY KEY,
        checksum_sha256 text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    if (!fs.existsSync(MIGRATION_DIR)) {
      throw new Error(`Migration directory not found: ${MIGRATION_DIR}`);
    }

    const files = fs.readdirSync(MIGRATION_DIR)
      .filter((name) => /^\d+.*\.sql$/i.test(name))
      .sort((a, b) => a.localeCompare(b));

    for (const file of files) {
      const fullPath = path.join(MIGRATION_DIR, file);
      const sql = fs.readFileSync(fullPath, "utf8");
      const checksum = sha256(sql);
      const existing = await client.query(
        `SELECT checksum_sha256 FROM schema_migrations WHERE migration_name=$1`,
        [file],
      );

      if (existing.rowCount) {
        const recorded = String(existing.rows[0]?.checksum_sha256 || "");
        if (recorded !== checksum) {
          throw new Error(
            `Migration checksum mismatch for ${file}. Applied migrations are immutable; create a new migration instead.`,
          );
        }
        console.log(`[migration] already applied: ${file}`);
        continue;
      }

      console.log(`[migration] applying: ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO schema_migrations(migration_name,checksum_sha256) VALUES($1,$2)`,
          [file, checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
      console.log(`[migration] applied: ${file}`);
    }
  } finally {
    if (locked) {
      await client.query("SELECT pg_advisory_unlock($1,$2)", [MIGRATION_LOCK_KEY_A, MIGRATION_LOCK_KEY_B]).catch(() => undefined);
    }
    client.release();
  }
}

async function main() {
  try {
    await ensureMigrationTable();
    await runMigrations();
    console.log("Database migrations complete.");
  } catch (error) {
    console.error("Database migration failed:", error);
    process.exitCode = 1;
  } finally {
    await db.end().catch(() => undefined);
  }
}

if (require.main === module) {
  void main();
}
