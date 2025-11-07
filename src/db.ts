// src/db.ts
import { Pool } from "pg";

function makePool(): Pool {
  // 1) Ha van DATABASE_URL (Render/Heroku), azt használjuk
  const url = process.env.DATABASE_URL;
  if (url) {
    const sslNeeded =
      process.env.PGSSLMODE === "require" ||
      process.env.NODE_ENV === "production";
    return new Pool({
      connectionString: url,
      ssl: sslNeeded ? { rejectUnauthorized: false } : false,
    } as any);
  }

  // 2) Egyébként klasszikus paraméterek
  return new Pool({
    host: process.env.PGHOST || "127.0.0.1",
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || "postgres",
    password: process.env.PGPASSWORD || "",
    database: process.env.PGDATABASE || "postgres",
    ssl: process.env.PGSSL === "1" ? { rejectUnauthorized: false } : false,
  } as any);
}

const pool = makePool();

// Egyszerű "ping"
export async function pingDb(): Promise<boolean> {
  const r = await pool.query("SELECT 1");
  return r.rowCount === 1;
}

export default pool;
