// src/db.ts
import { Pool, PoolConfig } from "pg";

const nodeEnv = process.env.NODE_ENV ?? "development";

// 1) Első próbálkozás: teljes connection string (Render DATABASE_URL)
const databaseUrl = process.env.DATABASE_URL?.trim();

let config: PoolConfig;

if (databaseUrl && databaseUrl !== "") {
  // Ha Render, PGSSLMODE=require vagy production, akkor SSL
  const sslEnabled =
    process.env.PGSSLMODE?.toLowerCase() === "require" ||
    databaseUrl.includes("render.com") ||
    nodeEnv === "production";

  config = {
    connectionString: databaseUrl,
    ssl: sslEnabled ? { rejectUnauthorized: false } : undefined,
  };

  console.log("🔧 PG pool init (URL)", {
    NODE_ENV: nodeEnv,
    USE_URL: true,
    SSL: sslEnabled ? "on" : "off",
  });
} else {
  // 2) Fallback: külön env változók
  const host =
    process.env.PGHOST ||
    process.env.DB_HOST ||
    "localhost";

  const port = Number(
    process.env.PGPORT ||
      process.env.DB_PORT ||
      5432
  );

  const user =
    process.env.PGUSER ||
    process.env.DB_USER ||
    "postgres";

  const password =
    process.env.PGPASSWORD ||
    process.env.DB_PASSWORD ||
    undefined;

  const database =
    process.env.PGDATABASE ||
    process.env.DB_NAME ||
    "postgres";

  const sslEnabled =
    process.env.PGSSLMODE?.toLowerCase() === "require";

  config = {
    host,
    port,
    user,
    password,
    database,
    ssl: sslEnabled ? { rejectUnauthorized: false } : undefined,
  };

  console.log("🔧 PG pool init (lokál/fallback)", {
    NODE_ENV: nodeEnv,
    host,
    port,
    user,
    database,
    ssl: sslEnabled ? "on" : "off",
  });
}

const pool = new Pool(config);

export default pool;
export { pool };
