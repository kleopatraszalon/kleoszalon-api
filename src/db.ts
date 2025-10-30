import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config();

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false,
});

pool.connect()
  .then(() => console.log("✅ Sikeres kapcsolat a PostgreSQL-hez"))
  .catch((err: Error) => console.error("❌ Kapcsolódási hiba:", err));

export default pool;
