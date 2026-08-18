import cron from "node-cron";
import db from "../db";

const TZ="Europe/Budapest";
let schemaPromise:Promise<void>|null=null;
let schedulerStarted=false;

const ROOT_TYPES=new Set(["work_order","purchase_order","booking","invoice"]);
const safeRootType=(v:unknown)=>{const s=String(v||"").trim();if(!ROOT_TYPES.has(s))throw Object.assign(new Error("Érvénytelen tranzakciótípus."),{status:400});return s};
const safeId=(v:unknown)=>{const s=String(v||"").trim();if(!s||s.length>160)throw Object.assign(new Error("Érvénytelen tranzakcióazonosító."),{status:400});return s};
const n=(v:unknown)=>{const x=Number(v??0);return Number.isFinite(x)?x:0};

async function tableExists(table:string){
  try{return Boolean((await db.query(`SELECT to_regclass($1) IS NOT NULL ok`,[`public.${table}`])).rows[0]?.ok)}catch{return false}
}

export function ensureTransactionTraceabilitySchema(){
  if(!schemaPromise){
    schemaPromise=db.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;

      CREATE TABLE IF NOT EXISTS business_transaction_traces(
        trace_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        root_type text NOT NULL,
        root_id text NOT NULL,
        location_id text NULL,
        title text NULL,
        lifecycle_status text NOT NULL DEFAULT 'active' CHECK(lifecycle_status IN('active','complete','incomplete','cancelled','unknown')),
        integrity_status text NOT NULL DEFAULT 'unknown' CHECK(integrity_status IN('unknown','verified','broken')),
        last_sequence bigint NOT NULL DEFAULT 0,
        last_hash text NULL,
        first_seen_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(root_type,root_id)
      );
      CREATE INDEX IF NOT EXISTS business_transaction_traces_recent_idx ON business_transaction_traces(last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS business_transaction_traces_location_idx ON business_transaction_traces(location_id,last_seen_at DESC);

      CREATE TABLE IF NOT EXISTS business_transaction_entities(
        id bigserial PRIMARY KEY,
        trace_id uuid NOT NULL REFERENCES business_transaction_traces(trace_id) ON DELETE CASCADE,
        entity_type text NOT NULL,
        entity_id text NOT NULL,
        relation text NOT NULL DEFAULT 'member',
        first_seen_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(trace_id,entity_type,entity_id)
      );
      CREATE INDEX IF NOT EXISTS business_transaction_entities_lookup_idx ON business_transaction_entities(entity_type,entity_id);

      CREATE TABLE IF NOT EXISTS business_transaction_events(
        event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        trace_id uuid NOT NULL REFERENCES business_transaction_traces(trace_id) ON DELETE RESTRICT,
        sequence bigint NOT NULL,
        event_type text NOT NULL,
        entity_type text NOT NULL,
        entity_id text NOT NULL,
        module_key text NOT NULL,
        action text NOT NULL,
        occurred_at timestamptz NOT NULL DEFAULT now(),
        actor_key text NULL,
        source text NOT NULL DEFAULT 'database-trigger',
        previous_hash text NULL,
        event_hash text NOT NULL,
        evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(trace_id,sequence),
        UNIQUE(trace_id,event_hash)
      );
      CREATE INDEX IF NOT EXISTS business_transaction_events_entity_idx ON business_transaction_events(entity_type,entity_id,occurred_at DESC);
      CREATE INDEX IF NOT EXISTS business_transaction_events_trace_idx ON business_transaction_events(trace_id,sequence);

      CREATE TABLE IF NOT EXISTS business_transaction_verifications(
        id bigserial PRIMARY KEY,
        trace_id uuid NOT NULL REFERENCES business_transaction_traces(trace_id) ON DELETE CASCADE,
        verified_at timestamptz NOT NULL DEFAULT now(),
        verified_by text NOT NULL DEFAULT 'system',
        event_count integer NOT NULL DEFAULT 0,
        broken_count integer NOT NULL DEFAULT 0,
        sequence_ok boolean NOT NULL DEFAULT false,
        hash_chain_ok boolean NOT NULL DEFAULT false,
        result text NOT NULL CHECK(result IN('verified','broken')),
        detail jsonb NOT NULL DEFAULT '{}'::jsonb
      );
      CREATE INDEX IF NOT EXISTS business_transaction_verifications_trace_idx ON business_transaction_verifications(trace_id,verified_at DESC);

      CREATE OR REPLACE FUNCTION kleo_transaction_event_immutable()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'business_transaction_events is append-only';
      END $$;
      DROP TRIGGER IF EXISTS trg_business_transaction_events_immutable ON business_transaction_events;
      CREATE TRIGGER trg_business_transaction_events_immutable BEFORE UPDATE OR DELETE ON business_transaction_events
      FOR EACH ROW EXECUTE FUNCTION kleo_transaction_event_immutable();

      CREATE OR REPLACE FUNCTION kleo_append_transaction_event(
        p_root_type text,p_root_id text,p_location_id text,p_event_type text,p_entity_type text,p_entity_id text,
        p_module_key text,p_action text,p_evidence jsonb DEFAULT '{}'::jsonb,p_metadata jsonb DEFAULT '{}'::jsonb,
        p_source text DEFAULT 'database-trigger',p_actor_key text DEFAULT NULL,p_occurred_at timestamptz DEFAULT now()
      ) RETURNS uuid LANGUAGE plpgsql AS $$
      DECLARE v_trace uuid;v_seq bigint;v_prev text;v_hash text;v_event uuid;
      BEGIN
        IF NULLIF(trim(COALESCE(p_root_type,'')),'') IS NULL OR NULLIF(trim(COALESCE(p_root_id,'')),'') IS NULL THEN RETURN NULL; END IF;
        INSERT INTO business_transaction_traces(root_type,root_id,location_id,title,last_seen_at,updated_at)
        VALUES(p_root_type,p_root_id,NULLIF(p_location_id,''),p_root_type||' · '||p_root_id,COALESCE(p_occurred_at,now()),now())
        ON CONFLICT(root_type,root_id) DO UPDATE SET
          location_id=COALESCE(business_transaction_traces.location_id,EXCLUDED.location_id),
          last_seen_at=GREATEST(business_transaction_traces.last_seen_at,EXCLUDED.last_seen_at),updated_at=now();

        SELECT trace_id,last_sequence,last_hash INTO v_trace,v_seq,v_prev
        FROM business_transaction_traces WHERE root_type=p_root_type AND root_id=p_root_id FOR UPDATE;
        v_seq:=COALESCE(v_seq,0)+1;v_event:=gen_random_uuid();
        v_hash:=encode(digest(concat_ws('|',v_trace::text,v_seq::text,COALESCE(v_prev,''),COALESCE(p_event_type,''),
          COALESCE(p_entity_type,''),COALESCE(p_entity_id,''),COALESCE(p_module_key,''),COALESCE(p_action,''),
          COALESCE(p_occurred_at,now())::text,COALESCE(p_evidence,'{}'::jsonb)::text,COALESCE(p_metadata,'{}'::jsonb)::text),'sha256'),'hex');
        INSERT INTO business_transaction_events(event_id,trace_id,sequence,event_type,entity_type,entity_id,module_key,action,occurred_at,actor_key,source,previous_hash,event_hash,evidence,metadata)
        VALUES(v_event,v_trace,v_seq,p_event_type,p_entity_type,p_entity_id,p_module_key,p_action,COALESCE(p_occurred_at,now()),NULLIF(p_actor_key,''),COALESCE(NULLIF(p_source,''),'database-trigger'),v_prev,v_hash,COALESCE(p_evidence,'{}'::jsonb),COALESCE(p_metadata,'{}'::jsonb));
        INSERT INTO business_transaction_entities(trace_id,entity_type,entity_id,relation,last_seen_at)
        VALUES(v_trace,p_entity_type,p_entity_id,'member',COALESCE(p_occurred_at,now()))
        ON CONFLICT(trace_id,entity_type,entity_id) DO UPDATE SET last_seen_at=GREATEST(business_transaction_entities.last_seen_at,EXCLUDED.last_seen_at);
        UPDATE business_transaction_traces SET last_sequence=v_seq,last_hash=v_hash,last_seen_at=GREATEST(last_seen_at,COALESCE(p_occurred_at,now())),updated_at=now() WHERE trace_id=v_trace;
        RETURN v_event;
      END $$;

      CREATE OR REPLACE FUNCTION kleo_capture_business_transaction()
      RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE j jsonb;v_entity_id text;v_root_type text;v_root_id text;v_location text;v_module text;v_evidence jsonb;v_actor text;v_related text;
      BEGIN
        j:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
        v_entity_id:=COALESCE(NULLIF(j->>'id',''),NULLIF(j->>'event_id',''));
        IF v_entity_id IS NULL THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
        v_location:=NULLIF(j->>'location_id','');
        v_actor:=COALESCE(NULLIF(j->>'updated_by',''),NULLIF(j->>'created_by',''),NULLIF(j->>'received_by',''),NULLIF(j->>'approved_by',''));
        v_module:=CASE
          WHEN TG_TABLE_NAME IN('work_orders','work_order_payments','work_order_settlements') THEN 'workorder'
          WHEN TG_TABLE_NAME IN('financial_movements','finance_invoices','nav_invoice_queue','accounting_journal_entries') THEN 'finance'
          WHEN TG_TABLE_NAME IN('purchase_orders','purchase_order_items','procurement_receipt_costs') THEN 'procurement'
          WHEN TG_TABLE_NAME='inventory_movements' THEN 'inventory'
          WHEN TG_TABLE_NAME='appointments' THEN 'booking' ELSE TG_TABLE_NAME END;

        CASE TG_TABLE_NAME
          WHEN 'appointments' THEN v_root_type:='booking';v_root_id:=v_entity_id;
          WHEN 'work_orders' THEN v_root_type:='work_order';v_root_id:=v_entity_id;
          WHEN 'work_order_payments' THEN v_root_type:='work_order';v_root_id:=NULLIF(j->>'work_order_id','');
          WHEN 'work_order_settlements' THEN v_root_type:='work_order';v_root_id:=NULLIF(j->>'work_order_id','');
          WHEN 'financial_movements' THEN
            IF NULLIF(j->>'work_order_id','') IS NOT NULL THEN v_root_type:='work_order';v_root_id:=j->>'work_order_id'; END IF;
          WHEN 'finance_invoices' THEN
            IF NULLIF(j->>'work_order_id','') IS NOT NULL THEN v_root_type:='work_order';v_root_id:=j->>'work_order_id';
            ELSIF NULLIF(j->>'purchase_order_id','') IS NOT NULL THEN v_root_type:='purchase_order';v_root_id:=j->>'purchase_order_id';
            ELSE v_root_type:='invoice';v_root_id:=v_entity_id; END IF;
          WHEN 'nav_invoice_queue' THEN
            IF to_regclass('public.finance_invoices') IS NOT NULL AND NULLIF(j->>'invoice_id','') IS NOT NULL THEN
              SELECT CASE WHEN NULLIF(to_jsonb(fi)->>'work_order_id','') IS NOT NULL THEN 'work_order'
                          WHEN NULLIF(to_jsonb(fi)->>'purchase_order_id','') IS NOT NULL THEN 'purchase_order' ELSE 'invoice' END,
                     COALESCE(NULLIF(to_jsonb(fi)->>'work_order_id',''),NULLIF(to_jsonb(fi)->>'purchase_order_id',''),fi.id::text),
                     COALESCE(v_location,NULLIF(to_jsonb(fi)->>'location_id',''))
                INTO v_root_type,v_root_id,v_location FROM finance_invoices fi WHERE fi.id::text=j->>'invoice_id' LIMIT 1;
            END IF;
          WHEN 'accounting_journal_entries' THEN
            IF to_regclass('public.finance_invoices') IS NOT NULL THEN
              SELECT CASE WHEN NULLIF(to_jsonb(fi)->>'work_order_id','') IS NOT NULL THEN 'work_order'
                          WHEN NULLIF(to_jsonb(fi)->>'purchase_order_id','') IS NOT NULL THEN 'purchase_order' ELSE 'invoice' END,
                     COALESCE(NULLIF(to_jsonb(fi)->>'work_order_id',''),NULLIF(to_jsonb(fi)->>'purchase_order_id',''),fi.id::text),
                     COALESCE(v_location,NULLIF(to_jsonb(fi)->>'location_id',''))
                INTO v_root_type,v_root_id,v_location FROM finance_invoices fi
               WHERE NULLIF(to_jsonb(fi)->>'journal_entry_id','')=v_entity_id ORDER BY NULLIF(to_jsonb(fi)->>'created_at','') DESC NULLS LAST LIMIT 1;
            END IF;
          WHEN 'purchase_orders' THEN v_root_type:='purchase_order';v_root_id:=v_entity_id;
          WHEN 'purchase_order_items' THEN v_root_type:='purchase_order';v_root_id:=NULLIF(j->>'purchase_order_id','');
          WHEN 'procurement_receipt_costs' THEN v_root_type:='purchase_order';v_root_id:=NULLIF(j->>'purchase_order_id','');
          WHEN 'inventory_movements' THEN
            IF NULLIF(j->>'work_order_id','') IS NOT NULL THEN v_root_type:='work_order';v_root_id:=j->>'work_order_id';
            ELSIF NULLIF(j->>'source_record_type','')='purchase_order' AND NULLIF(j->>'source_record_id','') IS NOT NULL THEN v_root_type:='purchase_order';v_root_id:=j->>'source_record_id'; END IF;
        END CASE;
        IF v_root_id IS NULL THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;

        v_evidence:=jsonb_strip_nulls(jsonb_build_object(
          'id',v_entity_id,'status',NULLIF(j->>'status',''),'payment_status',NULLIF(j->>'payment_status',''),
          'approval_status',NULLIF(j->>'approval_status',''),'amount',NULLIF(j->>'amount',''),'gross_total',NULLIF(j->>'gross_total',''),
          'invoice_no',NULLIF(j->>'invoice_no',''),'document_number',NULLIF(j->>'document_number',''),'work_order_id',NULLIF(j->>'work_order_id',''),
          'appointment_id',NULLIF(j->>'appointment_id',''),'purchase_order_id',NULLIF(j->>'purchase_order_id',''),'invoice_id',NULLIF(j->>'invoice_id',''),
          'journal_entry_id',NULLIF(j->>'journal_entry_id',''),'financial_movement_id',NULLIF(j->>'financial_movement_id',''),
          'cashier_shift_id',NULLIF(j->>'cashier_shift_id',''),'location_id',NULLIF(j->>'location_id',''),'movement_type',NULLIF(j->>'movement_type',''),
          'quantity',NULLIF(j->>'quantity',''),'balance_after',NULLIF(j->>'balance_after',''),'completed_at',NULLIF(j->>'completed_at',''),
          'cancelled_at',NULLIF(j->>'cancelled_at',''),'reversed_by_id',NULLIF(j->>'reversed_by_id','')));
        PERFORM kleo_append_transaction_event(v_root_type,v_root_id,v_location,TG_TABLE_NAME||'.'||lower(TG_OP),TG_TABLE_NAME,v_entity_id,v_module,lower(TG_OP),v_evidence,
          jsonb_build_object('db_operation',TG_OP,'table',TG_TABLE_NAME),'database-trigger',v_actor,clock_timestamp());
        RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
      END $$;

      DO $$ DECLARE t text;BEGIN
        FOREACH t IN ARRAY ARRAY['appointments','work_orders','work_order_payments','work_order_settlements','financial_movements','finance_invoices','nav_invoice_queue','accounting_journal_entries','purchase_orders','purchase_order_items','procurement_receipt_costs','inventory_movements'] LOOP
          IF to_regclass('public.'||t) IS NOT NULL THEN
            EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I','trg_kleo_trace_'||t,t);
            EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION kleo_capture_business_transaction()','trg_kleo_trace_'||t,t);
          END IF;
        END LOOP;
      END $$;
    `).then(()=>undefined).catch(error=>{schemaPromise=null;throw error});
  }
  return schemaPromise;
}

const EVIDENCE_KEYS=['id','status','payment_status','approval_status','amount','gross_total','invoice_no','document_number','work_order_id','appointment_id','purchase_order_id','invoice_id','journal_entry_id','financial_movement_id','cashier_shift_id','location_id','movement_type','quantity','balance_after','completed_at','cancelled_at','reversed_by_id','created_at','updated_at','received_at','ordered_at'];
function evidenceOf(row:any){const out:any={};for(const key of EVIDENCE_KEYS)if(row?.[key]!=null&&row[key]!=="")out[key]=row[key];return out}

async function appendSnapshot(rootType:string,rootId:string,entityType:string,row:any,moduleKey:string,relation="legacy_snapshot"){
  if(!row)return;
  const entityId=String(row.id??row.event_id??"").trim();if(!entityId)return;
  const exists=(await db.query(`SELECT 1 FROM business_transaction_entities e JOIN business_transaction_traces t ON t.trace_id=e.trace_id
    WHERE t.root_type=$1 AND t.root_id=$2 AND e.entity_type=$3 AND e.entity_id=$4 LIMIT 1`,[rootType,rootId,entityType,entityId])).rows[0];
  if(exists)return;
  const occurred=row.updated_at||row.created_at||row.completed_at||row.received_at||row.ordered_at||new Date().toISOString();
  await db.query(`SELECT kleo_append_transaction_event($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13::timestamptz)`,[
    rootType,rootId,row.location_id==null?null:String(row.location_id),`${entityType}.snapshot`,entityType,entityId,moduleKey,'snapshot',JSON.stringify(evidenceOf(row)),JSON.stringify({relation,backfilled:true}),'legacy-backfill',null,occurred
  ]);
}

async function rowsIf(table:string,sql:string,params:any[]){if(!(await tableExists(table)))return[];return(await db.query(sql,params)).rows}

export async function materializeTransactionTrace(rootTypeInput:string,rootIdInput:string){
  await ensureTransactionTraceabilitySchema();
  const rootType=safeRootType(rootTypeInput),rootId=safeId(rootIdInput);
  if(rootType==='work_order'){
    const wo=(await rowsIf('work_orders',`SELECT to_jsonb(w).* FROM work_orders w WHERE w.id::text=$1 LIMIT 1`,[rootId]))[0];
    if(!wo)throw Object.assign(new Error("A munkalap nem található."),{status:404});
    await appendSnapshot(rootType,rootId,'work_orders',wo,'workorder','root');
    const appointmentId=String(wo.appointment_id||'').trim();
    for(const row of await rowsIf('appointments',`SELECT to_jsonb(a).* FROM appointments a WHERE a.id::text=$1 OR NULLIF(to_jsonb(a)->>'work_order_id','')=$2`,[appointmentId||'__none__',rootId]))await appendSnapshot(rootType,rootId,'appointments',row,'booking');
    for(const row of await rowsIf('work_order_settlements',`SELECT to_jsonb(x).* FROM work_order_settlements x WHERE x.work_order_id::text=$1 ORDER BY COALESCE(NULLIF(to_jsonb(x)->>'created_at','')::timestamptz,now())`,[rootId]))await appendSnapshot(rootType,rootId,'work_order_settlements',row,'workorder');
    for(const row of await rowsIf('work_order_payments',`SELECT to_jsonb(x).* FROM work_order_payments x WHERE x.work_order_id::text=$1 ORDER BY COALESCE(NULLIF(to_jsonb(x)->>'created_at','')::timestamptz,now())`,[rootId]))await appendSnapshot(rootType,rootId,'work_order_payments',row,'finance');
    for(const row of await rowsIf('financial_movements',`SELECT to_jsonb(x).* FROM financial_movements x WHERE NULLIF(to_jsonb(x)->>'work_order_id','')=$1 ORDER BY COALESCE(NULLIF(to_jsonb(x)->>'created_at','')::timestamptz,NULLIF(to_jsonb(x)->>'occurred_at','')::timestamptz,now())`,[rootId]))await appendSnapshot(rootType,rootId,'financial_movements',row,'finance');
    const invoices=await rowsIf('finance_invoices',`SELECT to_jsonb(x).* FROM finance_invoices x WHERE NULLIF(to_jsonb(x)->>'work_order_id','')=$1 ORDER BY COALESCE(NULLIF(to_jsonb(x)->>'created_at','')::timestamptz,now())`,[rootId]);
    for(const row of invoices)await appendSnapshot(rootType,rootId,'finance_invoices',row,'finance');
    const invoiceIds=invoices.map((x:any)=>String(x.id)).filter(Boolean);
    if(invoiceIds.length)for(const row of await rowsIf('nav_invoice_queue',`SELECT to_jsonb(x).* FROM nav_invoice_queue x WHERE x.invoice_id::text=ANY($1::text[]) ORDER BY COALESCE(NULLIF(to_jsonb(x)->>'created_at','')::timestamptz,now())`,[invoiceIds]))await appendSnapshot(rootType,rootId,'nav_invoice_queue',row,'finance');
    const journalIds=invoices.map((x:any)=>String(x.journal_entry_id||'')).filter(Boolean);
    if(journalIds.length)for(const row of await rowsIf('accounting_journal_entries',`SELECT to_jsonb(x).* FROM accounting_journal_entries x WHERE x.id::text=ANY($1::text[])`,[journalIds]))await appendSnapshot(rootType,rootId,'accounting_journal_entries',row,'finance');
  }else if(rootType==='purchase_order'){
    const po=(await rowsIf('purchase_orders',`SELECT to_jsonb(x).* FROM purchase_orders x WHERE x.id::text=$1 LIMIT 1`,[rootId]))[0];
    if(!po)throw Object.assign(new Error("A beszerzési rendelés nem található."),{status:404});
    await appendSnapshot(rootType,rootId,'purchase_orders',po,'procurement','root');
    for(const row of await rowsIf('purchase_order_items',`SELECT to_jsonb(x).* FROM purchase_order_items x WHERE x.purchase_order_id::text=$1`,[rootId]))await appendSnapshot(rootType,rootId,'purchase_order_items',row,'procurement');
    for(const row of await rowsIf('procurement_receipt_costs',`SELECT to_jsonb(x).* FROM procurement_receipt_costs x WHERE x.purchase_order_id::text=$1 ORDER BY COALESCE(NULLIF(to_jsonb(x)->>'received_at','')::timestamptz,NULLIF(to_jsonb(x)->>'created_at','')::timestamptz,now())`,[rootId]))await appendSnapshot(rootType,rootId,'procurement_receipt_costs',row,'procurement');
    for(const row of await rowsIf('inventory_movements',`SELECT to_jsonb(x).* FROM inventory_movements x WHERE NULLIF(to_jsonb(x)->>'source_record_type','')='purchase_order' AND NULLIF(to_jsonb(x)->>'source_record_id','')=$1 ORDER BY COALESCE(NULLIF(to_jsonb(x)->>'created_at','')::timestamptz,now())`,[rootId]))await appendSnapshot(rootType,rootId,'inventory_movements',row,'inventory');
    const invoices=await rowsIf('finance_invoices',`SELECT to_jsonb(x).* FROM finance_invoices x WHERE NULLIF(to_jsonb(x)->>'purchase_order_id','')=$1 ORDER BY COALESCE(NULLIF(to_jsonb(x)->>'created_at','')::timestamptz,now())`,[rootId]);
    for(const row of invoices)await appendSnapshot(rootType,rootId,'finance_invoices',row,'finance');
    const journalIds=invoices.map((x:any)=>String(x.journal_entry_id||'')).filter(Boolean);
    if(journalIds.length)for(const row of await rowsIf('accounting_journal_entries',`SELECT to_jsonb(x).* FROM accounting_journal_entries x WHERE x.id::text=ANY($1::text[])`,[journalIds]))await appendSnapshot(rootType,rootId,'accounting_journal_entries',row,'finance');
  }else if(rootType==='booking'){
    const row=(await rowsIf('appointments',`SELECT to_jsonb(x).* FROM appointments x WHERE x.id::text=$1 LIMIT 1`,[rootId]))[0];if(!row)throw Object.assign(new Error("A foglalás nem található."),{status:404});await appendSnapshot(rootType,rootId,'appointments',row,'booking','root');
  }else if(rootType==='invoice'){
    const row=(await rowsIf('finance_invoices',`SELECT to_jsonb(x).* FROM finance_invoices x WHERE x.id::text=$1 LIMIT 1`,[rootId]))[0];if(!row)throw Object.assign(new Error("A számla nem található."),{status:404});await appendSnapshot(rootType,rootId,'finance_invoices',row,'finance','root');
  }
  return (await db.query(`SELECT * FROM business_transaction_traces WHERE root_type=$1 AND root_id=$2`,[rootType,rootId])).rows[0];
}

async function buildStages(rootType:string,rootId:string){
  if(rootType==='work_order'){
    const entities=(await db.query(`SELECT entity_type,evidence FROM business_transaction_events e JOIN business_transaction_traces t ON t.trace_id=e.trace_id WHERE t.root_type=$1 AND t.root_id=$2 ORDER BY e.sequence`,[rootType,rootId])).rows;
    const by=(type:string)=>entities.filter((x:any)=>x.entity_type===type);
    const invoice=by('finance_invoices').at(-1)?.evidence||{};const nav=by('nav_invoice_queue').at(-1)?.evidence||{};const journal=by('accounting_journal_entries').at(-1)?.evidence||{};
    return [
      {key:'booking',label:'Foglalás',status:by('appointments').length?'ok':'warning',evidence_count:by('appointments').length},
      {key:'work_order',label:'Munkalap',status:by('work_orders').length?'ok':'critical',evidence_count:by('work_orders').length},
      {key:'payment',label:'Fizetés',status:by('work_order_payments').length?'ok':'critical',evidence_count:by('work_order_payments').length},
      {key:'settlement',label:'Settlement',status:by('work_order_settlements').some((x:any)=>x.evidence?.completed_at)||by('work_order_settlements').length?'ok':'critical',evidence_count:by('work_order_settlements').length},
      {key:'cashier',label:'Pénztár',status:by('work_order_payments').some((x:any)=>x.evidence?.cashier_shift_id)?'ok':'critical',evidence_count:by('work_order_payments').filter((x:any)=>x.evidence?.cashier_shift_id).length},
      {key:'ledger',label:'Pénzügyi tranzakció',status:by('financial_movements').length||by('work_order_payments').some((x:any)=>x.evidence?.financial_movement_id)?'ok':'critical',evidence_count:by('financial_movements').length},
      {key:'invoice',label:'Számla',status:by('finance_invoices').length&&!['draft','cancelled','void'].includes(String(invoice.status||'').toLowerCase())?'ok':'critical',evidence_count:by('finance_invoices').length},
      {key:'nav',label:'NAV',status:String(nav.status||'').toLowerCase()==='done'?'ok':'critical',evidence_count:by('nav_invoice_queue').length},
      {key:'accounting',label:'Főkönyv',status:by('accounting_journal_entries').length&&['posted','approved'].includes(String(journal.status||'').toLowerCase())?'ok':'critical',evidence_count:by('accounting_journal_entries').length},
    ];
  }
  if(rootType==='purchase_order'){
    const entities=(await db.query(`SELECT entity_type,evidence FROM business_transaction_events e JOIN business_transaction_traces t ON t.trace_id=e.trace_id WHERE t.root_type=$1 AND t.root_id=$2 ORDER BY e.sequence`,[rootType,rootId])).rows;
    const by=(type:string)=>entities.filter((x:any)=>x.entity_type===type);const po=by('purchase_orders').at(-1)?.evidence||{};const invoice=by('finance_invoices').at(-1)?.evidence||{};const journal=by('accounting_journal_entries').at(-1)?.evidence||{};
    return [
      {key:'order',label:'Beszerzés',status:by('purchase_orders').length?'ok':'critical',evidence_count:by('purchase_orders').length},
      {key:'approval',label:'Jóváhagyás',status:['approved','auto_approved'].includes(String(po.approval_status||'').toLowerCase())?'ok':'critical',evidence_count:by('purchase_orders').length},
      {key:'receipt',label:'Bevételezés',status:by('procurement_receipt_costs').length||['received','partially_received'].includes(String(po.status||'').toLowerCase())?'ok':'critical',evidence_count:by('procurement_receipt_costs').length},
      {key:'inventory',label:'Készlet',status:by('inventory_movements').length?'ok':'critical',evidence_count:by('inventory_movements').length},
      {key:'invoice',label:'Bejövő számla',status:by('finance_invoices').length&&!['draft','cancelled','void'].includes(String(invoice.status||'').toLowerCase())?'ok':'critical',evidence_count:by('finance_invoices').length},
      {key:'accounting',label:'Könyvelés',status:by('accounting_journal_entries').length&&['posted','approved'].includes(String(journal.status||'').toLowerCase())?'ok':'critical',evidence_count:by('accounting_journal_entries').length},
    ];
  }
  return [{key:rootType,label:rootType,status:'ok',evidence_count:1}];
}

export async function verifyTransactionTrace(traceId:string,verifiedBy='system'){
  await ensureTransactionTraceabilitySchema();
  const rows=(await db.query(`WITH ordered AS(
    SELECT e.*,lag(event_hash) OVER(PARTITION BY trace_id ORDER BY sequence) expected_previous,
      row_number() OVER(PARTITION BY trace_id ORDER BY sequence) expected_sequence
    FROM business_transaction_events e WHERE trace_id=$1::uuid
  ),checked AS(
    SELECT *,encode(digest(concat_ws('|',trace_id::text,sequence::text,COALESCE(previous_hash,''),COALESCE(event_type,''),COALESCE(entity_type,''),COALESCE(entity_id,''),COALESCE(module_key,''),COALESCE(action,''),occurred_at::text,COALESCE(evidence,'{}'::jsonb)::text,COALESCE(metadata,'{}'::jsonb)::text),'sha256'),'hex') expected_hash
    FROM ordered)
    SELECT COUNT(*)::int event_count,
      COUNT(*) FILTER(WHERE sequence<>expected_sequence)::int sequence_errors,
      COUNT(*) FILTER(WHERE previous_hash IS DISTINCT FROM expected_previous)::int previous_hash_errors,
      COUNT(*) FILTER(WHERE event_hash<>expected_hash)::int event_hash_errors
    FROM checked`,[traceId])).rows[0]||{};
  const broken=n(rows.sequence_errors)+n(rows.previous_hash_errors)+n(rows.event_hash_errors);const verified=broken===0&&n(rows.event_count)>0;
  await db.query(`INSERT INTO business_transaction_verifications(trace_id,verified_by,event_count,broken_count,sequence_ok,hash_chain_ok,result,detail)
    VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8::jsonb)`,[traceId,verifiedBy,n(rows.event_count),broken,n(rows.sequence_errors)===0,n(rows.previous_hash_errors)===0&&n(rows.event_hash_errors)===0,verified?'verified':'broken',JSON.stringify(rows)]);
  await db.query(`UPDATE business_transaction_traces SET integrity_status=$2,updated_at=now() WHERE trace_id=$1::uuid`,[traceId,verified?'verified':'broken']);
  return {trace_id:traceId,event_count:n(rows.event_count),broken_count:broken,sequence_ok:n(rows.sequence_errors)===0,hash_chain_ok:n(rows.previous_hash_errors)===0&&n(rows.event_hash_errors)===0,result:verified?'verified':'broken',detail:rows,verified_at:new Date().toISOString()};
}

export async function getTransactionTrace(rootTypeInput:string,rootIdInput:string,verify=true){
  const rootType=safeRootType(rootTypeInput),rootId=safeId(rootIdInput);await materializeTransactionTrace(rootType,rootId);
  const trace=(await db.query(`SELECT * FROM business_transaction_traces WHERE root_type=$1 AND root_id=$2`,[rootType,rootId])).rows[0];
  if(!trace)throw Object.assign(new Error("A tranzakció-életút nem hozható létre."),{status:404});
  const stages=await buildStages(rootType,rootId);const lifecycleStatus=stages.some((x:any)=>x.status==='critical')?'incomplete':'complete';
  await db.query(`UPDATE business_transaction_traces SET lifecycle_status=$2,updated_at=now() WHERE trace_id=$1`,[trace.trace_id,lifecycleStatus]);trace.lifecycle_status=lifecycleStatus;
  const proof=verify?await verifyTransactionTrace(String(trace.trace_id),'live-read'):null;
  const [events,entities,verifications]=await Promise.all([
    db.query(`SELECT event_id,sequence,event_type,entity_type,entity_id,module_key,action,occurred_at,actor_key,source,previous_hash,event_hash,evidence,metadata FROM business_transaction_events WHERE trace_id=$1 ORDER BY sequence`,[trace.trace_id]),
    db.query(`SELECT entity_type,entity_id,relation,first_seen_at,last_seen_at FROM business_transaction_entities WHERE trace_id=$1 ORDER BY first_seen_at,entity_type`,[trace.trace_id]),
    db.query(`SELECT verified_at,verified_by,event_count,broken_count,sequence_ok,hash_chain_ok,result FROM business_transaction_verifications WHERE trace_id=$1 ORDER BY verified_at DESC LIMIT 10`,[trace.trace_id]),
  ]);
  let audit:any[]=[];
  if(await tableExists('system_audit_log')){
    const entityIds=entities.rows.map((x:any)=>String(x.entity_id));
    if(entityIds.length)audit=(await db.query(`SELECT id,occurred_at,actor_key,actor_name,location_id,module_key,entity_type,entity_id,action,severity,summary,metadata FROM system_audit_log WHERE entity_id=ANY($1::text[]) ORDER BY occurred_at DESC LIMIT 120`,[entityIds])).rows;
  }
  return {trace,proof,stages,events:events.rows,entities:entities.rows,verifications:verifications.rows,audit_events:audit};
}

export async function listRecentTransactionTraces(limit=50,locationId:string|null=null){
  await ensureTransactionTraceabilitySchema();const l=Math.max(1,Math.min(200,Number(limit||50)));
  const {rows}=await db.query(`SELECT t.*,(SELECT COUNT(*)::int FROM business_transaction_events e WHERE e.trace_id=t.trace_id) event_count,
    (SELECT result FROM business_transaction_verifications v WHERE v.trace_id=t.trace_id ORDER BY verified_at DESC LIMIT 1) verification_result
    FROM business_transaction_traces t WHERE ($1::text IS NULL OR t.location_id=$1) ORDER BY t.last_seen_at DESC LIMIT $2`,[locationId,l]);return rows;
}

export async function searchTransactionRoots(queryInput:string,limit=30){
  await ensureTransactionTraceabilitySchema();const q=String(queryInput||'').trim();if(q.length<2)return[];const l=Math.max(1,Math.min(80,Number(limit||30)));
  const rows=(await db.query(`SELECT trace_id,root_type,root_id,location_id,title,lifecycle_status,integrity_status,last_seen_at FROM business_transaction_traces
    WHERE root_id ILIKE $1 OR COALESCE(title,'') ILIKE $1 OR EXISTS(SELECT 1 FROM business_transaction_entities e WHERE e.trace_id=business_transaction_traces.trace_id AND e.entity_id ILIKE $1)
    ORDER BY last_seen_at DESC LIMIT $2`,[`%${q}%`,l])).rows;
  return rows;
}

export async function backfillRecentTransactionTraces(days=30,limit=500){
  await ensureTransactionTraceabilitySchema();const d=Math.max(1,Math.min(180,Number(days||30))),l=Math.max(1,Math.min(2000,Number(limit||500)));const out:any={work_orders:0,purchase_orders:0,errors:[]};
  if(await tableExists('work_orders')){
    const rows=(await db.query(`SELECT id::text id FROM work_orders WHERE COALESCE(NULLIF(to_jsonb(work_orders)->>'updated_at','')::timestamptz,NULLIF(to_jsonb(work_orders)->>'created_at','')::timestamptz,now())>=now()-($1::int||' days')::interval ORDER BY COALESCE(NULLIF(to_jsonb(work_orders)->>'updated_at','')::timestamptz,now()) DESC LIMIT $2`,[d,l])).rows;
    for(const row of rows){try{await materializeTransactionTrace('work_order',String(row.id));out.work_orders++}catch(error:any){out.errors.push({type:'work_order',id:String(row.id),message:error?.message||String(error)})}}
  }
  if(await tableExists('purchase_orders')){
    const rows=(await db.query(`SELECT id::text id FROM purchase_orders WHERE COALESCE(updated_at,created_at,now())>=now()-($1::int||' days')::interval ORDER BY COALESCE(updated_at,created_at) DESC LIMIT $2`,[d,l])).rows;
    for(const row of rows){try{await materializeTransactionTrace('purchase_order',String(row.id));out.purchase_orders++}catch(error:any){out.errors.push({type:'purchase_order',id:String(row.id),message:error?.message||String(error)})}}
  }
  const recent=(await db.query(`SELECT trace_id::text FROM business_transaction_traces ORDER BY last_seen_at DESC LIMIT $1`,[Math.min(l,500)])).rows;
  let verified=0,broken=0;for(const row of recent){try{const v=await verifyTransactionTrace(String(row.trace_id),'scheduled-maintenance');verified++;if(v.result==='broken')broken++}catch(error:any){out.errors.push({type:'verification',id:String(row.trace_id),message:error?.message||String(error)})}}
  return {...out,verified,broken,generated_at:new Date().toISOString()};
}

export function startTransactionTraceabilityMaintenance(){
  if(schedulerStarted||process.env.TRANSACTION_TRACE_DISABLED==='1'||process.env.NODE_ENV==='test')return;schedulerStarted=true;
  cron.schedule('35 2 * * *',()=>{void backfillRecentTransactionTraces(45,800).catch(error=>console.error('[transaction-trace] scheduled maintenance failed',error))},{timezone:TZ});
  const timer=setTimeout(()=>{void backfillRecentTransactionTraces(30,500).catch(error=>console.error('[transaction-trace] initial backfill failed',error))},90_000);timer.unref?.();
  console.log('[transaction-trace] append-only trace ledger + verification maintenance scheduled 02:35 Europe/Budapest');
}
