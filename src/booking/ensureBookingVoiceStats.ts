import { readFile } from "fs/promises";
import path from "path";
import db from "../db";
import ensureOnlineBooking from "./ensureOnlineBooking";

let promise: Promise<void> | null = null;

export function ensureBookingVoiceStats() {
  if (!promise) {
    promise = (async () => {
      // A statisztika már a pontos voice_event_id korrelációs mezőkre is épít.
      // Ezeket akkor is biztosítani kell, ha deploy után előbb nyitják meg a
      // statisztikát, mint bármely publikus foglalási végpontot.
      await ensureOnlineBooking();
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
