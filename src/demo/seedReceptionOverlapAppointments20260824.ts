import pool from "../db";

const SEED_KEY = "reception-overlap-demo-appointments-2026-08-24_30-v2";
const LOCATION_ID = "f99f8eec-e8c6-4e8f-b6a0-caf50c990f2a";
const DAYS = ["2026-08-24", "2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28", "2026-08-29", "2026-08-30"];
const GROUPS = [
  { time: "10:00", durations: [30, 60, 90], services: ["Női hajvágás", "Arckezelés", "Gél lakk manikűr"] },
  { time: "14:30", durations: [45, 75, 105, 120], services: ["Barber szakálligazítás", "Szempilla lifting", "Relax masszázs", "Alakformáló testkezelés"] },
];

async function seed() {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query(`CREATE TABLE IF NOT EXISTS demo_seed_runs(seed_key text PRIMARY KEY,created_at timestamptz NOT NULL DEFAULT now(),details jsonb NOT NULL DEFAULT '{}'::jsonb)`);
    if ((await db.query(`SELECT 1 FROM demo_seed_runs WHERE seed_key=$1`, [SEED_KEY])).rowCount) { await db.query("ROLLBACK"); return; }
    const employees = (await db.query(`SELECT id FROM employees WHERE location_id=$1::uuid AND COALESCE(active,true)=true ORDER BY full_name NULLS LAST,id LIMIT 16`, [LOCATION_ID])).rows;
    const clients = (await db.query(`SELECT id FROM clients WHERE location_id=$1::uuid OR location_id IS NULL ORDER BY created_at NULLS LAST,id LIMIT 40`, [LOCATION_ID])).rows;
    if (employees.length < 2) throw new Error("A párhuzamos demo időpontokhoz legalább két aktív munkatárs szükséges.");
    let inserted = 0;
    for (let dayIndex = 0; dayIndex < DAYS.length; dayIndex += 1) {
      for (let groupIndex = 0; groupIndex < GROUPS.length; groupIndex += 1) {
        const group = GROUPS[groupIndex];
        for (let itemIndex = 0; itemIndex < group.durations.length; itemIndex += 1) {
          const duration = group.durations[itemIndex];
          const marker = `[DEMO:${SEED_KEY}:${DAYS[dayIndex]}:${group.time}:${itemIndex}]`;
          const start = `${DAYS[dayIndex]} ${group.time}:00`;
          let created = false;
          for (let employeeOffset = 0; employeeOffset < employees.length && !created; employeeOffset += 1) {
            const employee = employees[(dayIndex + groupIndex * 4 + itemIndex + employeeOffset) % employees.length];
            const client = clients.length ? clients[(dayIndex * 7 + groupIndex * 4 + itemIndex) % clients.length] : null;
            const result = await db.query(`
              INSERT INTO appointments(employee_id,client_id,location_id,title,start_time,end_time,status,notes,created_at)
              SELECT $1::uuid,$2::uuid,$3::uuid,$4,$5::timestamp,($5::timestamp+($6::text||' minutes')::interval),'confirmed',$7,now()
              WHERE NOT EXISTS(SELECT 1 FROM appointments WHERE notes=$7)
                AND NOT EXISTS(SELECT 1 FROM appointments WHERE employee_id=$1::uuid AND status NOT IN('cancelled','canceled','no_show') AND start_time<($5::timestamp+($6::text||' minutes')::interval) AND end_time>$5::timestamp)
              RETURNING id
            `, [employee.id, client?.id || null, LOCATION_ID, group.services[itemIndex], start, duration, marker]);
            if (result.rowCount) { inserted += 1; created = true; }
          }
        }
      }
    }
    await db.query(`INSERT INTO demo_seed_runs(seed_key,details) VALUES($1,$2::jsonb)`, [SEED_KEY, JSON.stringify({ location_id: LOCATION_ID, from: DAYS[0], to: DAYS[6], inserted, overlap_groups: GROUPS })]);
    await db.query("COMMIT");
    console.log(`[demo-seed] ${inserted} párhuzamos, eltérő hosszúságú demo időpont létrehozva.`);
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { db.release(); }
}

let attempts = 0;
async function runWithRetry() {
  attempts += 1;
  try { await seed(); }
  catch (error: any) {
    console.error(`[demo-overlap-seed] próbálkozás ${attempts}/10 sikertelen:`, error?.message || error);
    if (attempts < 10) setTimeout(() => void runWithRetry(), 30_000);
  }
}
setTimeout(() => void runWithRetry(), 16_000);

