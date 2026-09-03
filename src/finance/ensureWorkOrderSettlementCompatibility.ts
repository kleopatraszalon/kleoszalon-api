import db from '../db';

let ready=false;
let pending:Promise<void>|null=null;

export async function ensureWorkOrderSettlementCompatibility(){
  if(ready)return;
  if(pending)return pending;
  pending=(async()=>{
    const state=(await db.query(`
      SELECT
        to_regclass('public.work_orders') IS NOT NULL AS work_orders,
        to_regclass('public.work_order_payments') IS NOT NULL AS work_order_payments,
        to_regclass('public.legal_entities') IS NOT NULL AS legal_entities,
        to_regclass('public.legal_entity_locations') IS NOT NULL AS legal_entity_locations,
        EXISTS(
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='work_orders' AND column_name='legal_entity_id'
        ) AS work_order_legal_entity
    `)).rows[0]||{};
    if(!state.work_orders||!state.work_order_payments||!state.legal_entities||!state.legal_entity_locations||!state.work_order_legal_entity){
      ready=true;
      return;
    }

    await db.query(`
      CREATE OR REPLACE FUNCTION vir_guard_work_order_legal_entity_change() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        has_receipt boolean:=false;
        has_conflict boolean:=false;
      BEGIN
        IF NEW.legal_entity_id IS NOT DISTINCT FROM OLD.legal_entity_id THEN RETURN NEW; END IF;
        IF NEW.legal_entity_id IS NULL OR NOT EXISTS(
          SELECT 1
          FROM legal_entity_locations el
          JOIN legal_entities e ON e.id=el.legal_entity_id
          WHERE el.legal_entity_id=NEW.legal_entity_id
            AND el.location_id=NEW.location_id
            AND el.active=true AND e.active=true
        ) THEN
          RAISE EXCEPTION 'A kiválasztott cég nincs hozzárendelve ehhez a szalonhoz.' USING ERRCODE='23514';
        END IF;

        -- Régi operatív munkalapok cég nélkül is létrejöhettek. NULL -> aktív,
        -- szalonhoz rendelt cég kitöltése adatjavítás, nem cégváltás. Megengedjük,
        -- ha nincs vele ellentmondó pénzügyi bizonyíték.
        IF OLD.legal_entity_id IS NULL THEN
          SELECT EXISTS(
            SELECT 1 FROM work_order_payments p
            WHERE p.work_order_id::text=OLD.id::text
              AND NULLIF(to_jsonb(p)->>'legal_entity_id','') IS NOT NULL
              AND (to_jsonb(p)->>'legal_entity_id')::uuid IS DISTINCT FROM NEW.legal_entity_id
          ) INTO has_conflict;
          IF has_conflict THEN
            RAISE EXCEPTION 'A munkalap meglévő fizetése más kibocsátó céghez tartozik.' USING ERRCODE='23514';
          END IF;
          IF to_regclass('public.finance_invoices') IS NOT NULL THEN
            EXECUTE 'SELECT EXISTS(SELECT 1 FROM finance_invoices i WHERE i.work_order_id::text=$1 AND NULLIF(to_jsonb(i)->>''legal_entity_id'','''') IS NOT NULL AND (to_jsonb(i)->>''legal_entity_id'')::uuid IS DISTINCT FROM $2)'
              INTO has_conflict USING OLD.id::text,NEW.legal_entity_id;
            IF has_conflict THEN
              RAISE EXCEPTION 'A munkalap meglévő számlája más kibocsátó céghez tartozik.' USING ERRCODE='23514';
            END IF;
          END IF;
          IF to_regclass('public.vir_receipts') IS NOT NULL THEN
            EXECUTE 'SELECT EXISTS(SELECT 1 FROM vir_receipts r WHERE r.source_type=''WORK_ORDER'' AND r.source_id=$1 AND NULLIF(to_jsonb(r)->>''legal_entity_id'','''') IS NOT NULL AND (to_jsonb(r)->>''legal_entity_id'')::uuid IS DISTINCT FROM $2)'
              INTO has_receipt USING OLD.id::text,NEW.legal_entity_id;
            IF has_receipt THEN
              RAISE EXCEPTION 'A munkalap meglévő nyugtája más kibocsátó céghez tartozik.' USING ERRCODE='23514';
            END IF;
          END IF;
          RETURN NEW;
        END IF;

        IF OLD.financial_closed_at IS NOT NULL OR COALESCE(OLD.fully_paid,false)=true OR COALESCE(OLD.payment_status,'')='paid' THEN
          RAISE EXCEPTION 'Pénzügyileg lezárt vagy kifizetett munkalap cége nem módosítható.' USING ERRCODE='23514';
        END IF;
        IF EXISTS(SELECT 1 FROM work_order_payments p WHERE p.work_order_id::text=OLD.id::text) THEN
          RAISE EXCEPTION 'Fizetést tartalmazó munkalap cége nem módosítható.' USING ERRCODE='23514';
        END IF;
        IF to_regclass('public.finance_invoices') IS NOT NULL THEN
          EXECUTE 'SELECT EXISTS(SELECT 1 FROM finance_invoices i WHERE i.work_order_id::text=$1)' INTO has_conflict USING OLD.id::text;
          IF has_conflict THEN RAISE EXCEPTION 'Számlát tartalmazó munkalap cége nem módosítható.' USING ERRCODE='23514'; END IF;
        END IF;
        IF to_regclass('public.vir_receipts') IS NOT NULL THEN
          EXECUTE 'SELECT EXISTS(SELECT 1 FROM vir_receipts WHERE source_type=''WORK_ORDER'' AND source_id=$1)' INTO has_receipt USING OLD.id::text;
          IF has_receipt THEN RAISE EXCEPTION 'Nyugtát tartalmazó munkalap cége nem módosítható.' USING ERRCODE='23514'; END IF;
        END IF;
        RETURN NEW;
      END $$;

      CREATE OR REPLACE FUNCTION vir_fill_legal_entity() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        location_value text;
        reversal_id_text text;
        work_order_location text;
        active_count integer:=0;
        resolved_id uuid;
      BEGIN
        IF NEW.legal_entity_id IS NOT NULL THEN RETURN NEW; END IF;

        IF NEW.work_order_id IS NOT NULL THEN
          SELECT w.legal_entity_id,w.location_id::text
            INTO NEW.legal_entity_id,work_order_location
          FROM work_orders w WHERE w.id::text=NEW.work_order_id::text;

          IF NEW.legal_entity_id IS NULL AND NULLIF(work_order_location,'') IS NOT NULL THEN
            SELECT COUNT(*)::int INTO active_count
            FROM legal_entity_locations el JOIN legal_entities e ON e.id=el.legal_entity_id
            WHERE el.location_id::text=work_order_location AND el.active=true AND e.active=true;

            SELECT el.legal_entity_id INTO resolved_id
            FROM legal_entity_locations el JOIN legal_entities e ON e.id=el.legal_entity_id
            WHERE el.location_id::text=work_order_location AND el.active=true AND e.active=true AND el.is_default=true
            ORDER BY e.created_at,el.legal_entity_id LIMIT 1;

            IF resolved_id IS NULL AND active_count=1 THEN
              SELECT el.legal_entity_id INTO resolved_id
              FROM legal_entity_locations el JOIN legal_entities e ON e.id=el.legal_entity_id
              WHERE el.location_id::text=work_order_location AND el.active=true AND e.active=true
              LIMIT 1;
            END IF;

            IF resolved_id IS NULL THEN
              IF active_count=0 THEN
                RAISE EXCEPTION 'A munkalap szalonjához nincs aktív kibocsátó cég rendelve.' USING ERRCODE='23514';
              END IF;
              RAISE EXCEPTION 'A munkalap szalonjához több aktív cég tartozik; jelöljön ki alapértelmezett kibocsátó céget.' USING ERRCODE='23514';
            END IF;
            NEW.legal_entity_id:=resolved_id;
          END IF;

          IF NEW.legal_entity_id IS NULL THEN
            RAISE EXCEPTION 'A munkalap pénzügyi művelete előtt válasszon kibocsátó céget.' USING ERRCODE='23514';
          END IF;
          RETURN NEW;
        END IF;

        IF TG_TABLE_NAME='financial_movements' THEN
          reversal_id_text:=to_jsonb(NEW)->>'reversal_of_id';
          IF NULLIF(btrim(COALESCE(reversal_id_text,'')),'') IS NOT NULL THEN
            SELECT legal_entity_id INTO NEW.legal_entity_id FROM financial_movements WHERE id::text=reversal_id_text;
          END IF;
        END IF;

        IF NEW.legal_entity_id IS NULL THEN
          location_value:=to_jsonb(NEW)->>'location_id';
          IF NULLIF(location_value,'') IS NOT NULL THEN
            SELECT el.legal_entity_id INTO NEW.legal_entity_id
            FROM legal_entity_locations el JOIN legal_entities e ON e.id=el.legal_entity_id
            WHERE el.location_id::text=location_value AND el.active=true AND e.active=true
            ORDER BY el.is_default DESC,e.created_at,el.legal_entity_id LIMIT 1;
          END IF;
        END IF;
        RETURN NEW;
      END $$;
    `);

    // A már meglévő, nyitott munkalapokat is javítjuk. Egyetlen régi rekord
    // hibája sem állíthatja meg a settlement recovery bootstrapot. A konkrét,
    // éppen fizetett munkalap a recovery tranzakcióban külön, fail-closed módon
    // kerül ellenőrzésre, ezért itt a best-effort backfill hibája biztonságosan
    // izolálható.
    await db.query(`
      DO $backfill$
      DECLARE
        r record;
        resolved_id uuid;
        active_count integer;
      BEGIN
        FOR r IN
          SELECT id::text AS id,location_id::text AS location_id
          FROM work_orders
          WHERE legal_entity_id IS NULL AND location_id IS NOT NULL AND financial_closed_at IS NULL
        LOOP
          resolved_id:=NULL;
          active_count:=0;
          SELECT COUNT(*)::int INTO active_count
          FROM legal_entity_locations el JOIN legal_entities e ON e.id=el.legal_entity_id
          WHERE el.location_id::text=r.location_id AND el.active=true AND e.active=true;

          SELECT el.legal_entity_id INTO resolved_id
          FROM legal_entity_locations el JOIN legal_entities e ON e.id=el.legal_entity_id
          WHERE el.location_id::text=r.location_id AND el.active=true AND e.active=true AND el.is_default=true
          ORDER BY e.created_at,el.legal_entity_id LIMIT 1;

          IF resolved_id IS NULL AND active_count=1 THEN
            SELECT el.legal_entity_id INTO resolved_id
            FROM legal_entity_locations el JOIN legal_entities e ON e.id=el.legal_entity_id
            WHERE el.location_id::text=r.location_id AND el.active=true AND e.active=true
            LIMIT 1;
          END IF;

          IF resolved_id IS NOT NULL THEN
            BEGIN
              UPDATE work_orders SET legal_entity_id=resolved_id WHERE id::text=r.id AND legal_entity_id IS NULL;
            EXCEPTION WHEN OTHERS THEN
              RAISE NOTICE 'Legacy workorder legal-entity backfill skipped for % [%]: %',r.id,SQLSTATE,SQLERRM;
            END;
          END IF;
        END LOOP;
      END
      $backfill$;
    `);

    ready=true;
  })().catch(error=>{
    pending=null;
    throw error;
  });
  return pending;
}

export default ensureWorkOrderSettlementCompatibility;
