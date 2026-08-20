import db from "../db";

let ready=false;
let running:Promise<void>|null=null;

export default async function ensureBookingV4Chain(){
  if(ready)return;
  if(running)return running;
  running=(async()=>{
    await db.query(`
      CREATE TABLE IF NOT EXISTS booking_chains(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        location_id uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
        client_id uuid NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
        status text NOT NULL DEFAULT 'active' CHECK(status IN('active','cancelled','completed')),
        start_time timestamptz NOT NULL,end_time timestamptz NOT NULL,total_gap_minutes int NOT NULL DEFAULT 0,
        booking_source text NOT NULL DEFAULT 'online',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK(end_time>start_time)
      );
      CREATE TABLE IF NOT EXISTS booking_chain_items(
        chain_id uuid NOT NULL REFERENCES booking_chains(id) ON DELETE CASCADE,
        appointment_id uuid NOT NULL UNIQUE REFERENCES appointments(id) ON DELETE CASCADE,
        sequence_no int NOT NULL,service_id uuid NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
        employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,start_time timestamptz NOT NULL,end_time timestamptz NOT NULL,
        PRIMARY KEY(chain_id,sequence_no),CHECK(sequence_no>=0),CHECK(end_time>start_time)
      );
      CREATE INDEX IF NOT EXISTS idx_booking_chain_items_employee_time ON booking_chain_items(employee_id,start_time,end_time);
      CREATE INDEX IF NOT EXISTS idx_booking_chains_client_created ON booking_chains(client_id,created_at DESC);
    `);
    ready=true;
  })().finally(()=>{running=null});
  return running;
}
