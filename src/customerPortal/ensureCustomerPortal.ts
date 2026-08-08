import { readFile } from "fs/promises";
import path from "path";
import pool from "../db";

let migrationPromise: Promise<void> | null = null;

export function ensureCustomerPortal() {
  if (!migrationPromise) {
    migrationPromise = (async () => {
      for (const file of [
        "20260808_LOYALTY_WALLET_V1.sql",
        "20260808_LOYALTY_V3_SALES_RULES.sql",
        "20260808_LOYALTY_V4_FINANCE_CUSTOMER.sql",
        "20260808_CUSTOMER_PORTAL_DEMO_V1.sql",
      ]) {
        const sqlPath = path.join(__dirname, "..", "sql", file);
        const sql = await readFile(sqlPath, "utf8");
        await pool.query(sql);
      }
    })().catch((error) => {
      migrationPromise = null;
      throw error;
    });
  }
  return migrationPromise;
}
