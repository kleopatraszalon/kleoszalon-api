import db from "../db";

const DEMO_DOMAIN = "demo-workorder.kleoszalon.hu";
const providerProfiles = [
  { suffix: "fodrasz", label: "DEMO Fodrász", qualification: "Fodrász", role: ["employee"] },
  { suffix: "kozmetikus", label: "DEMO Kozmetikus", qualification: "Kozmetikus", role: ["employee"] },
  { suffix: "kormos", label: "DEMO Körmös", qualification: "Kéz- és lábápoló", role: ["employee"] },
  { suffix: "masszor", label: "DEMO Masszőr", qualification: "Masszőr", role: ["employee"] },
];
const demoDuration = (value: unknown) => Math.min(90, Math.max(30, Number(value || 30)));

export async function ensureWorkOrderDemoData() {
  const cx = await db.connect();
  try {
    await cx.query("BEGIN");
    await cx.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await cx.query(`CREATE TABLE IF NOT EXISTS employee_service_overrides(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), employee_id text NOT NULL,
      service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      custom_price numeric(12,2), custom_duration_minutes integer,
      created_at timestamptz NOT NULL DEFAULT now())`);
    await cx.query(`CREATE UNIQUE INDEX IF NOT EXISTS employee_service_overrides_employee_service_uq ON employee_service_overrides(employee_id,service_id)`);
    await cx.query(`CREATE TABLE IF NOT EXISTS appointment_services(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
      service_id uuid NOT NULL REFERENCES services(id), duration_minutes integer NOT NULL DEFAULT 30,
      price numeric(12,2) NOT NULL DEFAULT 0, discount_percent numeric(5,2) NOT NULL DEFAULT 0,
      sort_order integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now())`);

    const locations = (await cx.query(`SELECT id,name FROM locations WHERE COALESCE(is_active,true)=true ORDER BY name`)).rows;
    const services = (await cx.query(`SELECT id,name,COALESCE(duration_minutes,30)::int duration_minutes,COALESCE(promo_price,list_price,base_price,0)::numeric price FROM services WHERE COALESCE(is_active,true)=true ORDER BY name LIMIT 80`)).rows;
    const clients = (await cx.query(`SELECT id FROM clients ORDER BY id LIMIT 80`)).rows;
    if (!locations.length || !services.length || !clients.length) {
      await cx.query("ROLLBACK");
      console.warn("DEMO seed kihagyva: locations/services/clients törzs hiányos.");
      return;
    }

    for (const location of locations) {
      const locKey = String(location.id).replace(/-/g, "").slice(0, 10);
      const receptionEmail = `recepcio.${locKey}@${DEMO_DOMAIN}`;
      await cx.query(`INSERT INTO employees(full_name,email,phone,qualification,location_id,active,role)
        SELECT $1,$2,$3,'Recepciós',$4::uuid,true,$5::jsonb
        WHERE NOT EXISTS(SELECT 1 FROM employees WHERE lower(email)=lower($2))`,
        [`DEMO Recepciós – ${location.name}`, receptionEmail, "+36 30 900 0000", location.id, JSON.stringify(["receptionist"])]);

      const providers: any[] = [];
      for (let p = 0; p < providerProfiles.length; p++) {
        const profile = providerProfiles[p];
        const email = `${profile.suffix}.${locKey}@${DEMO_DOMAIN}`;
        await cx.query(`INSERT INTO employees(full_name,email,phone,qualification,location_id,active,role)
          SELECT $1,$2,$3,$4,$5::uuid,true,$6::jsonb
          WHERE NOT EXISTS(SELECT 1 FROM employees WHERE lower(email)=lower($2))`,
          [`${profile.label} – ${location.name}`, email, `+36 30 90${p} 10${p}0`, profile.qualification, location.id, JSON.stringify(profile.role)]);
        const emp = (await cx.query(`SELECT id,full_name FROM employees WHERE lower(email)=lower($1) LIMIT 1`, [email])).rows[0];
        if (emp) providers.push(emp);
      }

      for (let p = 0; p < providers.length; p++) {
        const employee = providers[p];
        const picked = services.filter((_: any, i: number) => i % providers.length === p).slice(0, 8);
        const fallback = picked.length ? picked : services.slice(p * 4, p * 4 + 8);
        for (const service of fallback) {
          await cx.query(`INSERT INTO employee_service_overrides(employee_id,service_id,custom_duration_minutes)
            VALUES($1,$2::uuid,$3) ON CONFLICT(employee_id,service_id) DO NOTHING`,
            [String(employee.id), service.id, demoDuration(service.duration_minutes)]);
        }
      }

      for (let p = 0; p < providers.length; p++) {
        const employee = providers[p];
        const assigned = (await cx.query(`SELECT s.id,s.name,COALESCE(eo.custom_duration_minutes,s.duration_minutes,30)::int duration_minutes,
            COALESCE(eo.custom_price,s.promo_price,s.list_price,s.base_price,0)::numeric price
          FROM employee_service_overrides eo JOIN services s ON s.id=eo.service_id
          WHERE eo.employee_id=$1 ORDER BY s.name`, [String(employee.id)])).rows;
        if (!assigned.length) continue;
        for (let day = 0; day < 14; day++) {
          const dow = (new Date(Date.now() + day * 86400000)).getDay();
          if (dow === 0) continue;
          const slots = [9, 12, 15, 17];
          for (let slot = 0; slot < slots.length; slot++) {
            const service = assigned[(day + slot) % assigned.length];
            const duration = demoDuration(service.duration_minutes);
            const client = clients[(p * 17 + day * 4 + slot) % clients.length];
            const marker = `DEMO-WORKORDER:${locKey}:${String(employee.id).slice(0,8)}:${day}:${slot}`;
            const exists = await cx.query(`SELECT id FROM appointments WHERE notes=$1 AND start_time::date >= CURRENT_DATE LIMIT 1`, [marker]);
            if (exists.rowCount) continue;
            const status = day === 0 && slot === 0 ? "arrived" : "confirmed";
            const startExpr = `(CURRENT_DATE + $6::int + make_time($7::int,0,0)) AT TIME ZONE 'Europe/Budapest'`;
            const ap = await cx.query(`INSERT INTO appointments(employee_id,client_id,location_id,title,start_time,end_time,status,notes)
              VALUES($1::uuid,$2::uuid,$3::uuid,$4,${startExpr},${startExpr} + ($5::int || ' minutes')::interval,$8,$9)
              RETURNING id`, [employee.id, client.id, location.id, service.name, duration, day + 1, slots[slot], status, marker]);
            await cx.query(`INSERT INTO appointment_services(appointment_id,service_id,duration_minutes,price,discount_percent,sort_order)
              VALUES($1::uuid,$2::uuid,$3,$4,0,0)`, [ap.rows[0].id, service.id, duration, Number(service.price || 0)]);
          }
        }
      }
    }
    await cx.query("COMMIT");
    console.log(`DEMO workorder seed kész: ${locations.length} szalon, ${providerProfiles.length + 1} munkatárs/szalon, 14 napos foglalási minta.`);
  } catch (error) {
    await cx.query("ROLLBACK").catch(() => undefined);
    console.error("DEMO workorder seed hiba:", error);
    throw error;
  } finally {
    cx.release();
  }
}

export default ensureWorkOrderDemoData;
