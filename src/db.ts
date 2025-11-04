import "dotenv/config";
import { Pool } from "pg";


const useSSL =
  (process.env.DATABASE_SSL ?? "").toLowerCase() === "true" ||
  (process.env.RENDER ?? "").toLowerCase() === "true";

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASS,
  port: Number(process.env.DB_PORT),
});

export default pool;
