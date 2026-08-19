import crypto from "crypto";
import fs from "fs";
import path from "path";
import db from "./db";

const MIGRATION_LOCK_KEY_A = 20260819;
const MIGRATION_LOCK_KEY_B = 1;

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

export async function runMigrations() {
  const client = await db.connect();
  let locked = false;
  try {
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
