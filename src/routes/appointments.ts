import express from "express";
import pool from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = express.Router();
const actor = (req: AuthRequest) => req.user?.email || String(req.user?.id || "");

async function ensureBookingWorkOrderSchema(db: any) {
  await db.query(`
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS client_id uuid;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS client_name text;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS client_phone text;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS client_email text;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS location_id uuid;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS appointment_id uuid;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS created_by text;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS status_updated_at timestamptz NOT NULL DEFAULT now();
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS fully_paid boolean NOT NULL DEFAULT false;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS note_for_another_visitor boolean NOT NULL DEFAULT false;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS work_order_number text;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS source_created_at timestamptz;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS source_snapshot jsonb;
  `);
  await db.query(`
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS work_order_id uuid;
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS work_order_number text;
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS work_order_number_sequences(
      year integer PRIMARY KEY,
      last_value bigint NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.query(`
    CREATE OR REPLACE FUNCTION next_official_work_order_number(p_at timestamptz DEFAULT now())
    RETURNS text LANGUAGE plpgsql AS $$
    DECLARE y integer := EXTRACT(YEAR FROM p_at)::integer; n bigint;
    BEGIN
      INSERT INTO work_order_number_sequences(year,last_value) VALUES(y,1)
      ON CONFLICT(year) DO UPDATE SET last_value=work_order_number_sequences.last_value+1,updated_at=now()
      RETURNING last_value INTO n;
      RETURN 'KLEO-ML-'||y::text||'-'||LPAD(n::text,6,'0');
    END $$;
  `);
}

async function ensureAppointmentItemSchema(db: any) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS appointment_services(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
      service_id uuid NOT NULL REFERENCES services(id),
      duration_minutes integer NOT NULL DEFAULT 30,
      price numeric(12,2) NOT NULL DEFAULT 0,
      discount_percent numeric(5,2) NOT NULL DEFAULT 0,
      sort_order integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS appointment_products(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
      product_id uuid NOT NULL REFERENCES products(id),
      quantity numeric(12,3) NOT NULL DEFAULT 1,
      unit_price numeric(12,2) NOT NULL DEFAULT 0,
      sort_order integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

router.get("/conflicts", requireAuth, async (req: AuthRequest, res) => {
  try {
    const employeeId = String(req.query.employee_id || "").trim();
    const locationId = String(req.query.location_id || "").trim();
    const start = String(req.query.start || "").trim();
    const end = String(req.query.end || "").trim();
    const excludeId = String(req.query.exclude_id || "").trim();
    if (!employeeId || !start || !end) return res.status(400).json({ error: "employee_id, start és end kötelező" });
    const s = new Date(start), e = new Date(end);
    if (!Number.isFinite(s.getTime()) || !Number.isFinite(e.getTime()) || e <= s) return res.status(400).json({ error: "Érvénytelen időintervallum." });
    const { rows } = await pool.query(
      `SELECT id,title,start_time,end_time,status,employee_id,location_id
       FROM appointments
       WHERE employee_id=$1::uuid
         AND ($2::text='' OR location_id::text=$2 OR location_id IS NULL)
         AND ($5::text='' OR id::text<>$5)
         AND status NOT IN ('cancelled','canceled','no_show')
         AND start_time<$4::timestamptz AND end_time>$3::timestamptz
       ORDER BY start_time LIMIT 20`,
      [employeeId, locationId, start, end, excludeId],
    );
    res.json({ conflict: rows.length > 0, conflicts: rows });
  } catch (err: any) {
    console.error("[GET /api/appointments/conflicts]", err);
    res.status(500).json({ error: "Nem sikerült ellenőrizni az időpontütközést.", detail: err?.message });
  }
});

router.get("/products", requireAuth, async (req: AuthRequest, res) => {
  try {
    const locationId = String(req.query.location_id || "").trim();
    if (!locationId) return res.status(400).json({ error: "location_id kötelező" });
    const { rows } = await pool.query(
      `SELECT p.id::text,p.name,
              COALESCE(p.retail_price_gross,0)::numeric price,
              COALESCE(p.retail_price_gross,0)::numeric retail_price_gross,
              'db'::text unit,
              COALESCE(b.quantity,0)::numeric available_stock,
              COALESCE(b.quantity,0)::numeric stock_quantity,
              g.name product_group_name,c.name product_category_name,
              p.brand,p.line_name
       FROM products p
       LEFT JOIN product_stock_balances b ON b.product_id=p.id AND b.location_id=$1::uuid
       LEFT JOIN product_groups g ON g.id=p.product_group_id
       LEFT JOIN product_categories c ON c.id=p.product_category_id
       WHERE COALESCE(p.is_active,true)=true
       ORDER BY COALESCE(g.name,''),COALESCE(c.name,''),p.name`,
      [locationId],
    );
    res.json(rows);
  } catch (err: any) {
    console.error("[GET /api/appointments/products]", err);
    res.status(500).json({ error: "Nem sikerült betölteni a foglaláshoz választható termékeket.", detail: err?.message });
  }
});

router.post("/", requireAuth, async (req: AuthRequest, res) => {
  const {
    employee_id,
    start_time,
    end_time,
    title,
    client_id,
    client_name,
    location_id,
    notes,
    note,
    services = [],
    products = [],
  } = req.body || {};

  if (!employee_id || !start_time || !end_time) return res.status(400).json({ error: "employee_id, start_time, end_time kötelező" });
  const start = new Date(start_time), end = new Date(end_time);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return res.status(400).json({ error: "Érvénytelen kezdési vagy befejezési idő." });

  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await ensureBookingWorkOrderSchema(db);
    await ensureAppointmentItemSchema(db);

    const requestedIds = Array.isArray(services)
      ? services.map((x: any) => String(x?.service_id || x?.id || "")).filter(Boolean)
      : [];
    const uniqueServiceIds = Array.from(new Set(requestedIds));
    const serviceRows = uniqueServiceIds.length
      ? (await db.query(
          `SELECT id::text,name,COALESCE(duration_minutes,30)::int duration_minutes,
                  COALESCE(promo_price,list_price,base_price,0)::numeric price
           FROM services WHERE id=ANY($1::uuid[]) AND COALESCE(is_active,true)=true`,
          [uniqueServiceIds],
        )).rows
      : [];
    if (uniqueServiceIds.length && serviceRows.length !== uniqueServiceIds.length) {
      await db.query("ROLLBACK");
      return res.status(400).json({ error: "Egy vagy több kiválasztott szolgáltatás nem található vagy inaktív." });
    }

    const requestedProducts = Array.isArray(products) ? products : [];
    const productIds = Array.from(new Set(requestedProducts.map((x: any) => String(x?.product_id || x?.id || "")).filter(Boolean)));
    const productRows = productIds.length
      ? (await db.query(
          `SELECT p.id::text,p.name,COALESCE(p.retail_price_gross,0)::numeric price,
                  COALESCE(b.quantity,0)::numeric available_stock
           FROM products p
           LEFT JOIN product_stock_balances b ON b.product_id=p.id AND b.location_id=$2::uuid
           WHERE p.id=ANY($1::uuid[]) AND COALESCE(p.is_active,true)=true`,
          [productIds, location_id],
        )).rows
      : [];
    if (productIds.length && productRows.length !== productIds.length) {
      await db.query("ROLLBACK");
      return res.status(400).json({ error: "Egy vagy több kiválasztott termék nem található vagy inaktív." });
    }
    for (const item of requestedProducts) {
      const id = String(item?.product_id || item?.id || "");
      const row = productRows.find((product: any) => String(product.id) === id);
      const quantity = Number(item?.quantity || 0);
      if (!(quantity > 0)) {
        await db.query("ROLLBACK");
        return res.status(400).json({ error: `Érvénytelen termékmennyiség: ${row?.name || id}` });
      }
      if (row && quantity > Number(row.available_stock || 0)) {
        await db.query("ROLLBACK");
        return res.status(409).json({ error: `Nincs elegendő készlet: ${row.name}. Elérhető: ${Number(row.available_stock || 0).toLocaleString("hu-HU")} db.` });
      }
    }

    const conflict = await db.query(
      `SELECT id,start_time,end_time FROM appointments
       WHERE employee_id=$1::uuid AND status NOT IN ('cancelled','canceled','no_show')
         AND start_time<$3::timestamptz AND end_time>$2::timestamptz LIMIT 1`,
      [employee_id, start_time, end_time],
    );
    if (conflict.rows[0]) {
      await db.query("ROLLBACK");
      return res.status(409).json({ error: "A munkatársnak ebben az időszakban már van foglalása.", conflict: conflict.rows[0] });
    }

    const generatedTitle = serviceRows.length
      ? serviceRows.map((service: any) => service.name).join(", ")
      : (client_name ? `Foglalás - ${client_name}` : "Foglalás");
    const ap = await db.query(
      `INSERT INTO appointments(employee_id,client_id,location_id,title,start_time,end_time,status,notes)
       VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::timestamptz,$6::timestamptz,'confirmed',COALESCE($7,''))
       RETURNING id,created_at`,
      [employee_id, client_id || null, location_id || null, title || generatedTitle, start_time, end_time, notes ?? note ?? ""],
    );
    const appointmentId = ap.rows[0].id;

    for (let i = 0; i < serviceRows.length; i++) {
      const service = serviceRows[i];
      await db.query(
        `INSERT INTO appointment_services(appointment_id,service_id,duration_minutes,price,discount_percent,sort_order)
         VALUES($1,$2,$3,$4,0,$5)`,
        [appointmentId, service.id, service.duration_minutes, service.price, i],
      );
    }

    const appointmentProductSnapshot: any[] = [];
    for (let i = 0; i < requestedProducts.length; i++) {
      const requested = requestedProducts[i];
      const id = String(requested?.product_id || requested?.id || "");
      const product = productRows.find((row: any) => String(row.id) === id);
      if (!product) continue;
      const quantity = Number(requested.quantity || 1);
      await db.query(
        `INSERT INTO appointment_products(appointment_id,product_id,quantity,unit_price,sort_order)
         VALUES($1,$2,$3,$4,$5)`,
        [appointmentId, product.id, quantity, Number(product.price || 0), i],
      );
      appointmentProductSnapshot.push({
        product_id: product.id,
        name: product.name,
        quantity,
        unit_price: Number(product.price || 0),
      });
    }

    let clientRow: any = null;
    if (client_id) {
      const cols = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='clients'`);
      const set = new Set(cols.rows.map((x: any) => x.column_name));
      const nameExpr = set.has("full_name") && set.has("name")
        ? `COALESCE(NULLIF(full_name,''),NULLIF(name,''),'')`
        : set.has("full_name") ? `COALESCE(full_name,'')` : set.has("name") ? `COALESCE(name,'')` : `''`;
      clientRow = (await db.query(
        `SELECT id,${nameExpr} client_name,${set.has("phone") ? "phone" : "NULL::text phone"},${set.has("email") ? "email" : "NULL::text email"}
         FROM clients WHERE id=$1::uuid LIMIT 1`,
        [client_id],
      )).rows[0] || null;
    }

    const number = (await db.query(
      `SELECT next_official_work_order_number($1::timestamptz) work_order_number`,
      [ap.rows[0].created_at || new Date().toISOString()],
    )).rows[0].work_order_number;
    const sourceSnapshot = {
      appointment: {
        id: appointmentId,
        employee_id,
        client_id: client_id || null,
        location_id: location_id || null,
        title: title || generatedTitle,
        start_time,
        end_time,
        status: "confirmed",
        notes: notes ?? note ?? "",
      },
      services: serviceRows,
      products: appointmentProductSnapshot,
    };

    const wo = await db.query(
      `INSERT INTO work_orders(
        title,notes,status,employee_id,client_id,client_name,client_phone,client_email,location_id,appointment_id,
        fully_paid,note_for_another_visitor,created_by,status_updated_at,work_order_number,source_created_at,source_snapshot
       ) VALUES($1,$2,'waiting',$3,$4,$5,$6,$7,$8,$9,false,false,$10,now(),$11,now(),$12::jsonb)
       RETURNING id,work_order_number`,
      [
        title || generatedTitle,
        notes ?? note ?? null,
        employee_id,
        client_id || null,
        clientRow?.client_name || client_name || null,
        clientRow?.phone || null,
        clientRow?.email || null,
        location_id || null,
        appointmentId,
        actor(req) || null,
        number,
        JSON.stringify(sourceSnapshot),
      ],
    );
    const workOrderId = wo.rows[0].id;

    for (const service of serviceRows) {
      await db.query(
        `INSERT INTO work_order_items(work_order_id,item_type,service_id,item_name,quantity,unit_price,discount_amount,line_total,duration_minutes)
         VALUES($1,'service',$2,$3,1,$4,0,$4,$5)`,
        [workOrderId, service.id, service.name, Number(service.price || 0), service.duration_minutes || null],
      );
    }
    for (const item of appointmentProductSnapshot) {
      const lineTotal = Number(item.unit_price || 0) * Number(item.quantity || 0);
      await db.query(
        `INSERT INTO work_order_items(work_order_id,item_type,product_id,item_name,quantity,unit_price,discount_amount,line_total)
         VALUES($1,'product',$2,$3,$4,$5,0,$6)`,
        [workOrderId, item.product_id, item.name, item.quantity, item.unit_price, lineTotal],
      );
    }

    const recalc = await db.query(`SELECT to_regprocedure('recalc_work_order_totals(uuid)') IS NOT NULL ok`);
    if (recalc.rows[0]?.ok) await db.query(`SELECT recalc_work_order_totals($1::uuid)`, [workOrderId]);
    await db.query(
      `UPDATE appointments SET work_order_id=$2::uuid,work_order_number=$3 WHERE id=$1::uuid`,
      [appointmentId, workOrderId, number],
    );
    await db.query("COMMIT");
    res.status(201).json({
      id: appointmentId,
      services_count: serviceRows.length,
      products_count: appointmentProductSnapshot.length,
      work_order_id: workOrderId,
      work_order_number: number,
    });
  } catch (err: any) {
    await db.query("ROLLBACK").catch(() => undefined);
    console.error("[POST /api/appointments] error:", err);
    res.status(500).json({ error: "Nem sikerült létrehozni", detail: err?.message || String(err), code: err?.code || null });
  } finally {
    db.release();
  }
});

router.get("/:id/detail", requireAuth, async (req: AuthRequest, res) => {
  try {
    const ap = await pool.query(
      `SELECT a.*,COALESCE(c.full_name,c.name,'') client_name
       FROM appointments a LEFT JOIN clients c ON c.id=a.client_id WHERE a.id=$1`,
      [req.params.id],
    );
    if (!ap.rows[0]) return res.status(404).json({ error: "Nincs ilyen időpont" });
    await ensureAppointmentItemSchema(pool);
    const services = (await pool.query(
      `SELECT aps.id,aps.service_id,COALESCE(s.name,'') name,COALESCE(aps.duration_minutes,30) duration_minutes,aps.price,aps.sort_order
       FROM appointment_services aps LEFT JOIN services s ON s.id=aps.service_id
       WHERE aps.appointment_id=$1 ORDER BY aps.sort_order,aps.created_at`,
      [req.params.id],
    ).catch(() => ({ rows: [] } as any))).rows;
    const products = (await pool.query(
      `SELECT ap.id,ap.product_id,COALESCE(p.name,'') name,ap.quantity,ap.unit_price,
              (ap.quantity*ap.unit_price)::numeric line_total,ap.sort_order
       FROM appointment_products ap LEFT JOIN products p ON p.id=ap.product_id
       WHERE ap.appointment_id=$1 ORDER BY ap.sort_order,ap.created_at`,
      [req.params.id],
    ).catch(() => ({ rows: [] } as any))).rows;
    res.json({ appointment: ap.rows[0], services, products });
  } catch (err: any) {
    res.status(500).json({ error: "Nem sikerült betölteni", detail: err?.message });
  }
});

router.patch("/:id", requireAuth, async (req: AuthRequest, res) => {
  try {
    const cur = (await pool.query(`SELECT * FROM appointments WHERE id=$1::uuid`, [req.params.id])).rows[0];
    if (!cur) return res.status(404).json({ error: "Nincs ilyen időpont." });
    if (cur.work_order_id) {
      const lock = await pool.query(`SELECT locked_at,work_order_number FROM work_orders WHERE id=$1::uuid`, [cur.work_order_id]);
      if (lock.rows[0]?.locked_at) return res.status(409).json({ error: `A(z) ${lock.rows[0].work_order_number} munkalap lezárt és archivált; az időpont nem módosítható.` });
    }
    const fields: string[] = [], params: any[] = [];
    const add = (field: string, value: any, cast = "") => {
      if (value === undefined) return;
      params.push(value);
      fields.push(`${field}=$${params.length}${cast}`);
    };
    add("start_time", req.body?.start_time, "::timestamptz");
    add("end_time", req.body?.end_time, "::timestamptz");
    add("employee_id", req.body?.employee_id, "::uuid");
    add("location_id", req.body?.location_id, "::uuid");
    add("title", req.body?.title);
    add("status", req.body?.status);
    add("notes", req.body?.notes);
    if (!fields.length) return res.json({ ok: true });
    params.push(req.params.id);
    const result = await pool.query(
      `UPDATE appointments SET ${fields.join(",")} WHERE id=$${params.length}::uuid RETURNING id,work_order_id,work_order_number`,
      params,
    );
    res.json({ ok: true, ...result.rows[0] });
  } catch (err: any) {
    res.status(err?.code === "55000" ? 409 : 500).json({ error: err?.message || "Nem sikerült menteni" });
  }
});

export default router;
