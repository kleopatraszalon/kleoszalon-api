let repaired=false;
let repairPromise:Promise<void>|null=null;

export async function repairLegacyWorkOrderTriggers(c:any){
  if(repaired)return;
  if(repairPromise)return repairPromise;
  repairPromise=(async()=>{
    const exists=Boolean((await c.query(`SELECT to_regclass('public.work_orders') IS NOT NULL ok`)).rows[0]?.ok);
    if(!exists)return;

  // Some live databases have a UUID work_orders.id but legacy child/link
  // columns stored as text (and others have the inverse).  Trigger PL/pgSQL
  // resolves `text = uuid` before it can run, so compare identifiers through
  // their canonical text representation at every legacy boundary.
    await c.query(`
    CREATE OR REPLACE FUNCTION archive_and_lock_work_order()
    RETURNS trigger LANGUAGE plpgsql AS $archive$
    DECLARE snap jsonb; h text;
    BEGIN
      IF OLD.locked_at IS NOT NULL THEN
        RAISE EXCEPTION 'A(z) % munkalap lezárt és archivált; nem módosítható.',OLD.work_order_number USING ERRCODE='55000';
      END IF;
      IF NEW.status IN ('completed','cancelled','no_show') AND OLD.status IS DISTINCT FROM NEW.status THEN
        NEW.locked_at:=COALESCE(NEW.locked_at,now());
        NEW.locked_reason:=COALESCE(NEW.locked_reason,'TERMINAL_STATUS:'||upper(NEW.status));
        NEW.archived_at:=COALESCE(NEW.archived_at,now());
        snap:=jsonb_build_object(
          'header',to_jsonb(NEW),
          'items',COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.created_at,i.id) FROM work_order_items i WHERE i.work_order_id::text=NEW.id::text),'[]'::jsonb),
          'payments',COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.paid_at,p.id) FROM work_order_payments p WHERE p.work_order_id::text=NEW.id::text),'[]'::jsonb)
        );
        h:=encode(digest(convert_to(snap::text,'UTF8'),'sha256'),'hex');
        NEW.archive_hash:=h;
        INSERT INTO work_order_archive(work_order_id,work_order_number,archived_at,terminal_status,snapshot,snapshot_hash)
        VALUES(NEW.id::text::uuid,NEW.work_order_number,NEW.archived_at,NEW.status,snap,h)
        ON CONFLICT(work_order_id) DO NOTHING;
      END IF;
      RETURN NEW;
    END $archive$;
  `);

    await c.query(`
    CREATE OR REPLACE FUNCTION prevent_locked_appointment_change()
    RETURNS trigger LANGUAGE plpgsql AS $appointment$
    DECLARE l timestamptz; n text;
    BEGIN
      IF OLD.work_order_id IS NOT NULL THEN
        SELECT locked_at,work_order_number INTO l,n FROM work_orders WHERE id::text=OLD.work_order_id::text;
        IF l IS NOT NULL THEN
          RAISE EXCEPTION 'Az időponthoz tartozó % munkalap lezárt/archivált; az időpont sem módosítható vagy törölhető.',n USING ERRCODE='55000';
        END IF;
      END IF;
      IF TG_OP='DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END $appointment$;
  `);

    await c.query(`
    CREATE OR REPLACE FUNCTION prevent_child_change_of_locked_work_order()
    RETURNS trigger LANGUAGE plpgsql AS $child$
    DECLARE wid text; l timestamptz; n text;
    BEGIN
      IF TG_OP='DELETE' THEN wid:=OLD.work_order_id::text; ELSE wid:=NEW.work_order_id::text; END IF;
      SELECT locked_at,work_order_number INTO l,n FROM work_orders WHERE id::text=wid;
      IF l IS NOT NULL THEN
        RAISE EXCEPTION 'A(z) % munkalap lezárt/archivált; kapcsolódó tételei sem módosíthatók.',n USING ERRCODE='55000';
      END IF;
      IF TG_OP='DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END $child$;
  `);
    repaired=true;
  })();
  try{await repairPromise}
  catch(error){repairPromise=null;throw error}
}
