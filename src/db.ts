import { Pool } from "pg";
import "dotenv/config";

const useSSL =
  (process.env.DATABASE_SSL ?? "").toLowerCase() === "true" ||
  (process.env.RENDER ?? "").toLowerCase() === "true";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
});
export default pool;