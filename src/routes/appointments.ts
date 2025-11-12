// File: backend/src/routes/appointments.ts
// Purpose: CRUD-ish API for appointments + free slots endpoint
// Generated: 2025-11-12 16:21
import { Router } from "express";
import { Pool } from "pg";
import { z } from "zod";

const r = Router();
const pool = new Pool(); // relies on PG* env vars

const createSchema = z.object({
  location_id: z.string().uuid(),
  employee_id: z.string().uuid(),
  client_id:   z.string().uuid().optional().nullable(),
  service_id:  z.string().uuid(),
  title:       z.string().optional(),
  start_time:  z.string(),  // 'YYYY-MM-DD HH:mm'
  end_time:    z.string(),
  price:       z.number().optional(),
  notes:       z.string().optional()
});

r.get("/", async (req, res) => {
  const { location_id, from, to, employee_id } = req.query as any;
  const q = `
    SELECT * FROM public.v_appointment_details
    WHERE ($1::uuid IS NULL OR location_id=$1::uuid)
      AND ($2::timestamp IS NULL OR start_time >= $2::timestamp)
      AND ($3::timestamp IS NULL OR end_time   <= $3::timestamp)
      AND ($4::uuid IS NULL OR employee_id=$4::uuid)
    ORDER BY start_time`;
  const { rows } = await pool.query(q, [
    location_id ?? null, from ?? null, to ?? null, employee_id ?? null
  ]);
  res.json(rows);
});

r.get("/free-slots", async (req, res) => {
  const { location_id, employee_id, day, slot_minutes } = req.query as any;
  const q = `SELECT * FROM public.free_slots($1::uuid, $2::uuid, $3::date, COALESCE($4::int, 15))`;
  const { rows } = await pool.query(q, [
    location_id, employee_id ?? null, day, slot_minutes ?? null
  ]);
  res.json(rows);
});

r.post("/", async (req, res) => {
  const data = createSchema.parse(req.body);
  const q = `
    INSERT INTO public.appointments
      (id, location_id, employee_id, client_id, service_id, title, start_time, end_time, status, price, notes)
    VALUES (gen_random_uuid(), $1,$2,$3,$4,$5,$6,$7,'booked',$8,$9)
    RETURNING id`;
  const { rows } = await pool.query(q, [
    data.location_id, data.employee_id, data.client_id ?? null, data.service_id,
    data.title ?? null, data.start_time, data.end_time, data.price ?? null, data.notes ?? null
  ]);
  res.json({ id: rows[0].id, success: true });
});

r.post("/:id/cancel", async (req, res) => {
  const { reason } = req.body ?? {};
  const q = `UPDATE public.appointments
             SET status='cancelled', notes = CONCAT(COALESCE(notes,''), E'\nLemondás: ', $2)
             WHERE id=$1 RETURNING id`;
  const { rows } = await pool.query(q, [req.params.id, reason ?? ""]);
  res.json({ id: rows[0]?.id, success: true });
});

export default r;
