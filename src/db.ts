// src/db.ts
import { Pool } from "pg";

/**
 * Fejlesztői / production pool létrehozása
 */
function makePool(): Pool {
  const isProd = process.env.NODE_ENV === "production";

  // Render / production: DATABASE_URL
  if (isProd && process.env.DATABASE_URL) {
    return new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl:
        process.env.DB_SSL === "1"
          ? { rejectUnauthorized: false }
          : undefined,
    });
  }

  // Lokális fejlesztés
  return new Pool({
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? "5432"),
    user: process.env.DB_USER ?? "postgres",
    password: process.env.DB_PASSWORD ?? "postgres",
    database: process.env.DB_NAME ?? "kleoszalon",
  });
}

const pool = makePool();

export default pool;
export { pool };
