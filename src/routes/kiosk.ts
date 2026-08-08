import { Router } from "express";
import { pool } from "../db";

export const kioskRouter = Router();

const clean = (v: unknown) => String(v ?? "").trim();
const qty = (v: unknown) => Math.max(1, Math.min(99, Number(v) || 1));

kioskRouter.get("/context", async (req, res) => {
  try {
    const locationId = clean(req.query.location_id || req.query.locationId);
    const [locations, employees] = await Promise.all([
      pool.query(`SELECT id::text id,name FROM locations WHERE COALESCE(is_active,true)=true ORDER BY name`),
      pool.query(
        `SELECT id::text id,COALESCE(NULLIF(full_name,''),NULLIF(concat_ws(' ',last_name,first_name),''),'Munkatárs') full_name,
                location_id::text location_id,photo_url
         FROM employees
         WHERE COALESCE(active,true)=true AND ($1::text='' OR location_id::text=$1 OR location_id IS NULL)
         ORDER BY COALESCE(NULLIF(full_name,''),last_name,first_name,'')`,
        [locationId]
      ),
    ]);
    res.json({ ok: true, locations: locations.rows, employees: employees.rows });
  } catch (e: any) {
    console.error("Kiosk context hiba:", e);
    res.status(500).json({ ok: false, error: "kiosk_context_failed", detail: e?.message || String(e) });
  }
});

kioskRouter.get("/services", async (req, res) => {
  try {
    const language = clean(req.query.lang) || "hu";
    const locationId = clean(req.query.locationId || req.query.location_id);
    const r = await pool.query(
      `SELECT s.id::text id,s.name,s.description,
              COALESCE(s.promo_price,s.list_price,s.base_price,0)::numeric price,
              COALESCE(s.duration_minutes,30)::int duration_minutes,
              s.service_type_id::text category_id,
              COALESCE(st.name,'Egyéb') category_name
       FROM services s
       LEFT JOIN service_types st ON st.id=s.service_type_id
       WHERE COALESCE(s.is_active,true)=true
         AND ($1::text='' OR NOT EXISTS(SELECT 1 FROM service_locations sl0 WHERE sl0.service_id=s.id)
              OR EXISTS(SELECT 1 FROM service_locations sl WHERE sl.service_id=s.id AND sl.location_id::text=$1))
       ORDER BY COALESCE(st.name,'Egyéb'),s.name`,
      [locationId]
    );
    const services = r.rows.map((row: any) => ({
      id: String(row.id), name: row.name, name_hu: row.name, description: row.description ?? null,
      list_price: Number(row.price || 0), base_price: Number(row.price || 0),
      duration_minutes: Number(row.duration_minutes || 30), category_id: row.category_id,
      category_name: row.category_name, category_name_hu: row.category_name,
    }));
    const map = new Map<string, any>();
    for (const s of services) {
      const id = String(s.category_id || s.category_name || "other");
      if (!map.has(id)) map.set(id, { id, name: s.category_name || "Egyéb", image_path: null });
    }
    res.json({ ok: true, language, categories: Array.from(map.values()), services });
  } catch (e: any) {
    console.error("Kiosk services hiba:", e);
    res.status(500).json({ ok: false, error: "kiosk_services_failed", detail: e?.message || String(e) });
  }
});

kioskRouter.post("/workorders", async (req, res) => {
  const locationId = clean(req.body?.location_id);
  const employeeId = clean(req.body?.employee_id);
  const clientName = clean(req.body?.client_name);
  const phone = clean(req.body?.phone);
  const email = clean(req.body?.email);
  const note = clean(req.body?.note);
  const paymentMethod = clean(req.body?.payment_method) || "reception";
  const items = Array.isArray(req.body?.items) ? req.body.items : [];

  if (!locationId || !clientName || (!phone && !email) || !items.length) {
    return res.status(400).json({ error: "Telephely, vendégnév, elérhetőség és legalább egy tétel szükséges." });
  }

  const cx = await pool.connect();
  try {
    await cx.query("BEGIN");
    const loc = await cx.query(`SELECT id,name FROM locations WHERE id=$1::uuid AND COALESCE(is_active,true)=true`, [locationId]);
    if (!loc.rows[0]) { await cx.query("ROLLBACK"); return res.status(400).json({ error: "A kiválasztott szalon nem található." }); }

    let client = await cx.query(
      `SELECT id,COALESCE(NULLIF(full_name,''),NULLIF(name,''),'') client_name,phone,email
       FROM clients WHERE location_id=$1::uuid AND
       (($2<>'' AND regexp_replace(COALESCE(phone,''),'[^0-9]','','g')=regexp_replace($2,'[^0-9]','','g'))
        OR ($3<>'' AND lower(COALESCE(email,''))=lower($3)))
       ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
      [locationId, phone, email]
    );
    let clientId = client.rows[0]?.id;
    if (!clientId) {
      client = await cx.query(
        `INSERT INTO clients(full_name,name,phone,email,location_id,marketing_consent,is_active,source,created_at,updated_at)
         VALUES($1,$1,$2,$3,$4::uuid,false,true,'kiosk',now(),now()) RETURNING id`,
        [clientName, phone || null, email || null, locationId]
      );
      clientId = client.rows[0].id;
    }

    if (employeeId) {
      const emp = await cx.query(`SELECT id FROM employees WHERE id=$1::uuid AND COALESCE(active,true)=true`, [employeeId]);
      if (!emp.rows[0]) { await cx.query("ROLLBACK"); return res.status(400).json({ error: "A kiválasztott munkatárs nem található." }); }
    }

    const number = (await cx.query(`SELECT next_official_work_order_number(now()) work_order_number`)).rows[0].work_order_number;
    const sourceSnapshot = { source: "kiosk", payment_method: paymentMethod, items, location_id: locationId };
    const header = await cx.query(
      `INSERT INTO work_orders(title,notes,status,employee_id,client_id,client_name,client_phone,client_email,location_id,
         fully_paid,note_for_another_visitor,created_by,status_updated_at,work_order_number,source_created_at,source_snapshot)
       VALUES('Kiosk rendelés / szolgáltatás',$1,'waiting',$2::uuid,$3::uuid,$4,$5,$6,$7::uuid,false,false,'public-kiosk',now(),$8,now(),$9::jsonb)
       RETURNING id,work_order_number,status,created_at`,
      [note || `Kiosk fizetési mód: ${paymentMethod}`, employeeId || null, clientId, clientName, phone || null, email || null, locationId, number, JSON.stringify(sourceSnapshot)]
    );
    const workOrderId = header.rows[0].id;

    for (const raw of items) {
      const kind = clean(raw?.kind || raw?.meta?.kind).toLowerCase();
      const id = clean(raw?.id);
      const quantity = qty(raw?.qty);
      if (!id) continue;
      if (kind === "product") {
        const p = (await cx.query(`SELECT id,name,COALESCE(sale_price,retail_price_gross,0)::numeric price FROM products WHERE id=$1::uuid LIMIT 1`, [id])).rows[0];
        if (p) await cx.query(
          `INSERT INTO work_order_items(work_order_id,item_type,product_id,item_name,quantity,unit_price,discount_amount,line_total)
           VALUES($1,'product',$2,$3,$4,$5,0,$4*$5)`,
          [workOrderId, p.id, p.name, quantity, Number(p.price || 0)]
        );
      } else if (kind === "service") {
        const s = (await cx.query(`SELECT id,name,COALESCE(promo_price,list_price,base_price,0)::numeric price,COALESCE(duration_minutes,30)::int duration FROM services WHERE id=$1::uuid LIMIT 1`, [id])).rows[0];
        if (s) await cx.query(
          `INSERT INTO work_order_items(work_order_id,item_type,service_id,item_name,quantity,unit_price,discount_amount,line_total,duration_minutes)
           VALUES($1,'service',$2,$3,$4,$5,0,$4*$5,$6)`,
          [workOrderId, s.id, s.name, quantity, Number(s.price || 0), s.duration]
        );
      } else {
        // Büfé/egyéb kiosk tétel: névvel és a kliens által látott árral rögzítjük.
        const unitPrice = Number(raw?.price || 0);
        await cx.query(
          `INSERT INTO work_order_items(work_order_id,item_type,item_name,quantity,unit_price,discount_amount,line_total)
           VALUES($1,'product',$2,$3,$4,0,$3*$4)`,
          [workOrderId, clean(raw?.title) || "Kiosk tétel", quantity, unitPrice]
        );
      }
    }

    const recalc = (await cx.query(`SELECT to_regprocedure('recalc_work_order_totals(uuid)') IS NOT NULL ok`)).rows[0]?.ok;
    if (recalc) await cx.query(`SELECT recalc_work_order_totals($1::uuid)`, [workOrderId]);
    await cx.query("COMMIT");
    res.status(201).json({ ok: true, ...header.rows[0], source: "kiosk", payment_method: paymentMethod });
  } catch (e: any) {
    await cx.query("ROLLBACK").catch(() => undefined);
    console.error("Kiosk workorder hiba:", e);
    res.status(500).json({ error: "A kiosk munkalap létrehozása sikertelen.", detail: e?.message || String(e) });
  } finally {
    cx.release();
  }
});

export default kioskRouter;
