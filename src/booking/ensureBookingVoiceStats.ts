import { readFile } from "fs/promises";
import path from "path";
import db from "../db";

let promise: Promise<void> | null = null;

export function ensureBookingVoiceStats() {
  if (!promise) {
    promise = (async () => {
      const sqlPath = path.join(__dirname, "..", "sql", "20260810_BOOKING_VOICE_STATS_V1.sql");
      const sql = await readFile(sqlPath, "utf8");
      await db.query(sql);
    })().catch((error) => {
      promise = null;
      throw error;
    });
  }
  return promise;
}

export default ensureBookingVoiceStats;
