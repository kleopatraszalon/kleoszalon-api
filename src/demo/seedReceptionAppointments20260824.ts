import "./seedKioskCafeRetail20260830";
import pool from "../db";

const SEED_KEY = "reception-demo-appointments-2026-08-24_30-v1";
const LOCATION_ID = "f99f8eec-e8c6-4e8f-b6a0-caf50c990f2a";
const DAYS = ["2026-08-24", "2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28", "2026-08-29", "2026-08-30"];
const SLOTS = ["09:00", "10:30", "12:00", "14:00", "15:30", "17:00"];
const SERVICES = [
  "Női hajvágás és styling", "Barber haj- és szakálligazítás", "Arckezelés", "Szempilla lifting",
  "Alkalmi smink", "Gél lakk manikűr", "Spa pedikűr", "Relax masszázs", "Alakformáló testkezelés", "Szolárium",
];

async function seed() {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query(`CREATE TABLE IF NOT EXISTS demo_seed_runs(seed_key text PRIMARY KEY,created_at timestamptz NOT NULL DEFAULT now(),details jsonb NOT NULL DEFAULT '{}'::jsonb)`);
    if ((await db.query(`SELECT 1 FROM demo_seed_runs WHERE seed_key=$1`, [SEED_KEY])).rowCount) {
      await db.query("ROLLBACK");
      return;
    }
    const location = (await db.query(`SELECT id FROM locations WHERE id=$1::uuid LIMIT 1`, [LOCATION_ID])).rows[0];
    if (!location) throw new Error("A demo időpontok céltelephelye nem található.");
    const employees = (await db.query(`SELECT id FROM employees WHERE location_id=$1::uuid AND COALESCE(active,true)=true ORDER BY full_name NULLS LAST,id LIMIT 12`, [LOCATION_ID])).rows;
    const clients = (await db.query(`SELECT id FROM clients WHERE location_id=$1::uuid OR location_id IS NULL ORDER BY created_at NULLS LAST,id LIMIT 30`, [LOCATION_ID])).rows;
    if (!employees.length) throw new Error("A demo időpontokhoz nincs aktív munkatárs a telephelyen.");
    let inserted = 0;
    for (let dayIndex = 0; dayIndex < DAYS.length; dayIndex += 1) {
      for (let slotIndex = 0; slotIndex < SLOTS.length; slotIndex += 1) {
        const marker = `[DEMO:${SEED_KEY}:${DAYS[dayIndex]}:${SLOTS[slotIndex]}]`;
        const employee = employees[(dayIndex * 2 + slotIndex) % employees.length];
        const client = clients.length ? clients[(dayIndex * SLOTS.length + slotIndex) % clients.length] : null;
        const service = SERVICES[(dayIndex * SLOTS.length + slotIndex) % SERVICES.length];
        const result = await db.query(`
          INSERT INTO appointments(employee_id,client_id,location_id,title,start_time,end_time,status,notes,created_at)
          SELECT $1::uuid,$2::uuid,$3::uuid,$4,$5::timestamp,($5::timestamp+interval '60 minutes'),'confirmed',$6,now()
          WHERE NOT EXISTS(SELECT 1 FROM appointments WHERE notes=$6)
            AND NOT EXISTS(SELECT 1 FROM appointments WHERE employee_id=$1::uuid AND status NOT IN('cancelled','canceled','no_show') AND start_time<($5::timestamp+interval '60 minutes') AND end_time>$5::timestamp)
          RETURNING id
        `, [employee.id, client?.id || null, LOCATION_ID, service, `${DAYS[dayIndex]} ${SLOTS[slotIndex]}:00`, marker]);
        inserted += result.rowCount || 0;
      }
    }
    await db.query(`INSERT INTO demo_seed_runs(seed_key,details) VALUES($1,$2::jsonb)`, [SEED_KEY, JSON.stringify({ location_id: LOCATION_ID, from: DAYS[0], to: DAYS[DAYS.length - 1], inserted })]);
    await db.query("COMMIT");
    console.log(`[demo-seed] ${inserted} recepciós demo időpont létrehozva (${DAYS[0]}–${DAYS[DAYS.length - 1]}).`);
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
}

let attempts = 0;
async function runWithRetry() {
  attempts += 1;
  try { await seed(); }
  catch (error: any) {
    console.error(`[demo-seed] próbálkozás ${attempts}/10 sikertelen:`, error?.message || error);
    if (attempts < 10) setTimeout(() => void runWithRetry(), 30_000);
  }
}

setTimeout(() => void runWithRetry(), 12_000);
