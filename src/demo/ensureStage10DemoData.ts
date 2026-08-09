import db from "../db";

const MARKER = "DEMO-STAGE10";

export async function ensureStage10DemoData() {
  const cx = await db.connect();
  try {
    await cx.query("BEGIN");
    await cx.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE TABLE IF NOT EXISTS salon_stock_requests(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL REFERENCES locations(id), product_id uuid NOT NULL REFERENCES products(id),
        requested_quantity numeric(14,3) NOT NULL CHECK(requested_quantity>0), approved_quantity numeric(14,3), supplied_quantity numeric(14,3) NOT NULL DEFAULT 0,
        status text NOT NULL DEFAULT 'requested' CHECK(status IN('requested','approved','partially_supplied','supplied','cancelled')),
        source text NOT NULL DEFAULT 'manual', source_work_order_id uuid, note text, created_by text, approved_by text, created_at timestamptz NOT NULL DEFAULT now(), approved_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
      ALTER TABLE salon_stock_requests ADD COLUMN IF NOT EXISTS purchase_order_id bigint;
      CREATE TABLE IF NOT EXISTS stock_transfers(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid REFERENCES salon_stock_requests(id), product_id uuid NOT NULL REFERENCES products(id), destination_location_id uuid NOT NULL REFERENCES locations(id),
        quantity numeric(14,3) NOT NULL CHECK(quantity>0), status text NOT NULL DEFAULT 'prepared' CHECK(status IN('prepared','dispatched','received','cancelled')),
        dispatched_by text, received_by text, dispatched_at timestamptz, received_at timestamptz, note text, created_at timestamptz NOT NULL DEFAULT now());
      ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS unit_cost numeric(14,4) NOT NULL DEFAULT 0;
      CREATE TABLE IF NOT EXISTS stock_transfer_discrepancies(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), transfer_id uuid NOT NULL REFERENCES stock_transfers(id), expected_quantity numeric(14,3) NOT NULL,
        received_quantity numeric(14,3) NOT NULL, shortage_quantity numeric(14,3) NOT NULL, status text NOT NULL DEFAULT 'open', reported_by text,
        note text, created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz, resolved_by text);`);

    const prereq = (await cx.query(`SELECT to_regclass('public.suppliers') suppliers,
      to_regclass('public.product_supplier_terms') supplier_terms,
      to_regclass('public.product_stock_balances') balances`)).rows[0];
    if (!prereq.suppliers || !prereq.supplier_terms || !prereq.balances) {
      await cx.query("ROLLBACK");
      console.warn("DEMO Stage10 seed kihagyva: a beszerzési/készletséma még nem áll rendelkezésre.");
      return;
    }

    const locations = (await cx.query(`SELECT id,name FROM locations WHERE COALESCE(is_active,true)=true ORDER BY name LIMIT 4`)).rows;
    const products = (await cx.query(`SELECT id,name FROM products WHERE COALESCE(is_active,true)=true ORDER BY name LIMIT 8`)).rows;
    if (!locations.length || products.length < 3) {
      await cx.query("ROLLBACK");
      console.warn("DEMO Stage10 seed kihagyva: legalább 1 szalon és 3 aktív termék szükséges.");
      return;
    }

    await cx.query(`INSERT INTO suppliers(name,email,contact_name,address,payment_terms_days,default_lead_time_days,active,note)
      SELECT 'DEMO Beszállító – 10. etap','demo.procurement@kleoszalon.hu','DEMO Kapcsolattartó','DEMO központi raktár',8,3,true,$1
      WHERE NOT EXISTS(SELECT 1 FROM suppliers WHERE lower(name)=lower('DEMO Beszállító – 10. etap'))`, [MARKER]);
    const supplier = (await cx.query(`SELECT id FROM suppliers WHERE lower(name)=lower('DEMO Beszállító – 10. etap') LIMIT 1`)).rows[0];

    for (let i=0;i<products.length;i++) {
      const p=products[i];
      const baseCost=1200+i*250;
      await cx.query(`INSERT INTO product_stock_balances(product_id,location_id,quantity,min_quantity,unit_cost,updated_at)
        SELECT $1::uuid,NULL,$2,5,$3,now()
        WHERE NOT EXISTS(SELECT 1 FROM product_stock_balances WHERE product_id=$1::uuid AND location_id IS NULL)`, [p.id, i===0?30:i===1?15:i===2?4:10, baseCost]);
      await cx.query(`UPDATE product_stock_balances b SET quantity=GREATEST(COALESCE(b.quantity,0),$2),
          min_quantity=CASE WHEN COALESCE(b.min_quantity,0)<=0 THEN 5 ELSE b.min_quantity END,
          unit_cost=CASE WHEN COALESCE(b.unit_cost,0)<=0 THEN $3 ELSE b.unit_cost END,updated_at=now()
        WHERE b.product_id=$1::uuid AND b.location_id IS NULL
          AND NOT EXISTS(SELECT 1 FROM inventory_movements m WHERE m.product_id=b.product_id AND m.location_id IS NULL)`,
        [p.id, i===0?30:i===1?15:i===2?4:10, baseCost]);
      if (supplier?.id) {
        await cx.query(`INSERT INTO product_supplier_terms(product_id,supplier_id,supplier_product_code,unit_price,minimum_order_quantity,lead_time_days,preferred,active,note)
          VALUES($1,$2,$3,$4,$5,3,$6,true,$7)
          ON CONFLICT(product_id,supplier_id) DO UPDATE SET unit_price=EXCLUDED.unit_price,
            minimum_order_quantity=EXCLUDED.minimum_order_quantity,lead_time_days=EXCLUDED.lead_time_days,
            preferred=EXCLUDED.preferred,active=true,note=EXCLUDED.note,updated_at=now()`,
          [p.id,supplier.id,`DEMO-${String(i+1).padStart(3,'0')}`,baseCost,5,i<3,MARKER]);
      }
    }

    const loc0=locations[0], loc1=locations[1]||locations[0], loc2=locations[2]||locations[0];
    const p0=products[0], p1=products[1], p2=products[2];
    const central0=Number((await cx.query(`SELECT COALESCE(quantity,0) q FROM product_stock_balances WHERE product_id=$1 AND location_id IS NULL LIMIT 1`,[p0.id])).rows[0]?.q||0);
    const central1=Number((await cx.query(`SELECT COALESCE(quantity,0) q FROM product_stock_balances WHERE product_id=$1 AND location_id IS NULL LIMIT 1`,[p1.id])).rows[0]?.q||0);
    const central2=Number((await cx.query(`SELECT COALESCE(quantity,0) q FROM product_stock_balances WHERE product_id=$1 AND location_id IS NULL LIMIT 1`,[p2.id])).rows[0]?.q||0);

    const insertRequest = async(locationId:string, productId:string, qty:number, status:'requested'|'approved', marker:string) => {
      await cx.query(`INSERT INTO salon_stock_requests(location_id,product_id,requested_quantity,approved_quantity,status,source,note,created_by,approved_by,approved_at)
        SELECT $1::uuid,$2::uuid,$3,CASE WHEN $4='approved' THEN $3 ELSE NULL END,$4,'demo',$5,'demo-stage10-seed',
          CASE WHEN $4='approved' THEN 'demo-stage10-seed' ELSE NULL END,CASE WHEN $4='approved' THEN now() ELSE NULL END
        WHERE NOT EXISTS(SELECT 1 FROM salon_stock_requests WHERE note=$5)`, [locationId,productId,qty,status,marker]);
    };

    await insertRequest(loc0.id,p0.id,Math.max(2,Math.min(5,central0||5)),'requested',`${MARKER}:JOVAHAGYAS:${loc0.id}:${p0.id}`);
    await insertRequest(loc1.id,p1.id,Math.max(2,Math.min(5,central1||5)),'approved',`${MARKER}:KOZPONTI-KIADAS:${loc1.id}:${p1.id}`);
    await insertRequest(loc2.id,p2.id,Math.max(10,central2+25),'approved',`${MARKER}:BESZALLITOI-HIANY:${loc2.id}:${p2.id}`);

    const preparedRequest = (await cx.query(`SELECT r.* FROM salon_stock_requests r WHERE r.note LIKE $1 AND r.status='approved' ORDER BY r.created_at LIMIT 1`, [`${MARKER}:KOZPONTI-KIADAS:%`])).rows[0];
    if (preparedRequest) {
      const existing = await cx.query(`SELECT id FROM stock_transfers WHERE request_id=$1 AND status IN('prepared','dispatched','received') LIMIT 1`,[preparedRequest.id]);
      if (!existing.rows[0]) {
        const bal=(await cx.query(`SELECT quantity,unit_cost FROM product_stock_balances WHERE product_id=$1 AND location_id IS NULL LIMIT 1`,[preparedRequest.product_id])).rows[0];
        const qty=Math.min(Number(preparedRequest.approved_quantity||preparedRequest.requested_quantity),Math.max(0,Number(bal?.quantity||0)),3);
        if (qty>0) await cx.query(`INSERT INTO stock_transfers(request_id,product_id,destination_location_id,quantity,unit_cost,status,note)
          VALUES($1,$2,$3,$4,$5,'prepared',$6)`,[preparedRequest.id,preparedRequest.product_id,preparedRequest.location_id,qty,Number(bal?.unit_cost||0),`${MARKER}:ELOKESZITETT-ATADAS`]);
      }
    }

    await cx.query("COMMIT");
    console.log(`DEMO Stage10 seed kész: ${locations.length} szalonminta, ${products.length} termék, jóváhagyási/központi kiadási/beszállítói hiány ág.`);
  } catch (error) {
    await cx.query("ROLLBACK").catch(()=>undefined);
    console.error("DEMO Stage10 seed hiba:",error);
    throw error;
  } finally { cx.release(); }
}

export default ensureStage10DemoData;
