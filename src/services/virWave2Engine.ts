import axios from "axios";
import db from "../db";

const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const clamp=(v:number,min:number,max:number)=>Math.min(max,Math.max(min,v));
const num=(v:unknown)=>Number.isFinite(Number(v))?Number(v):0;
let schemaPromise:Promise<void>|null=null;
let workerStarted=false;

export async function ensureVirWave2Schema(){
 if(!schemaPromise)schemaPromise=db.query(`
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE TABLE IF NOT EXISTS service_material_requirements(
    id bigserial PRIMARY KEY,service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,default_quantity numeric(14,3) NOT NULL DEFAULT 1,
    unit text NOT NULL DEFAULT 'db',required boolean NOT NULL DEFAULT true,active boolean NOT NULL DEFAULT true,note text,
    created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(service_id,product_id));
  ALTER TABLE service_material_requirements ADD COLUMN IF NOT EXISTS waste_percent numeric(5,2) NOT NULL DEFAULT 0;
  ALTER TABLE service_material_requirements ADD COLUMN IF NOT EXISTS updated_by text;
  ALTER TABLE service_material_requirements ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1;

  CREATE TABLE IF NOT EXISTS vir_workflow_rules(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL,event_key text NOT NULL,active boolean NOT NULL DEFAULT true,
    mode text NOT NULL DEFAULT 'advisory' CHECK(mode IN('advisory','assisted')),conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
    actions jsonb NOT NULL DEFAULT '[]'::jsonb,cooldown_minutes int NOT NULL DEFAULT 0 CHECK(cooldown_minutes BETWEEN 0 AND 525600),
    location_id uuid REFERENCES locations(id) ON DELETE CASCADE,created_by text,updated_by text,
    created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
  CREATE INDEX IF NOT EXISTS vir_workflow_rules_event_idx ON vir_workflow_rules(event_key,active,location_id);

  CREATE TABLE IF NOT EXISTS vir_workflow_events(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_key text NOT NULL,entity_type text NOT NULL,entity_id text,
    location_id uuid REFERENCES locations(id) ON DELETE SET NULL,payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','processing','processed','failed')),
    attempts int NOT NULL DEFAULT 0,last_error text,created_at timestamptz NOT NULL DEFAULT now(),processed_at timestamptz);
  CREATE INDEX IF NOT EXISTS vir_workflow_events_pending_idx ON vir_workflow_events(status,created_at) WHERE status IN('pending','failed');

  CREATE TABLE IF NOT EXISTS vir_workflow_actions(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_id uuid NOT NULL REFERENCES vir_workflow_events(id) ON DELETE CASCADE,
    rule_id uuid NOT NULL REFERENCES vir_workflow_rules(id) ON DELETE CASCADE,action_index int NOT NULL,action_type text NOT NULL,
    entity_type text,entity_id text,location_id uuid REFERENCES locations(id) ON DELETE SET NULL,status text NOT NULL DEFAULT 'prepared',
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,created_at timestamptz NOT NULL DEFAULT now(),executed_at timestamptz,
    UNIQUE(event_id,rule_id,action_index));
  CREATE INDEX IF NOT EXISTS vir_workflow_actions_status_idx ON vir_workflow_actions(status,created_at DESC);

  CREATE TABLE IF NOT EXISTS vir_client_brief_cache(
    client_id uuid PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,source_fingerprint text NOT NULL,brief jsonb NOT NULL,
    ai_used boolean NOT NULL DEFAULT false,model text,generated_at timestamptz NOT NULL DEFAULT now());

  CREATE OR REPLACE FUNCTION vir_capture_workorder_event() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF TG_OP='UPDATE' AND COALESCE(OLD.status,'')=COALESCE(NEW.status,'') THEN RETURN NEW; END IF;
    INSERT INTO vir_workflow_events(event_key,entity_type,entity_id,location_id,payload)
    VALUES('workorder.status.'||lower(COALESCE(NEW.status,'unknown')),'work_order',NEW.id::text,NEW.location_id,
      jsonb_build_object('status',NEW.status,'work_order_number',NEW.work_order_number,'client_id',NEW.client_id,
        'employee_id',NEW.employee_id,'location_id',NEW.location_id,'gross_total',NEW.gross_total,'amount_due',NEW.amount_due,
        'payment_status',NEW.payment_status));
    RETURN NEW;
  END $$;
  DO $$ BEGIN
    IF to_regclass('public.work_orders') IS NOT NULL THEN
      DROP TRIGGER IF EXISTS trg_vir_workorder_workflow_event ON work_orders;
      CREATE TRIGGER trg_vir_workorder_workflow_event AFTER INSERT OR UPDATE OF status ON work_orders
      FOR EACH ROW EXECUTE FUNCTION vir_capture_workorder_event();
    END IF;
  END $$;

  CREATE OR REPLACE FUNCTION vir_capture_appointment_event() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE ev text;
  BEGIN
    IF TG_OP='INSERT' THEN ev:='appointment.created';
    ELSIF COALESCE(OLD.status,'')<>COALESCE(NEW.status,'') THEN ev:='appointment.status.'||lower(COALESCE(NEW.status,'unknown'));
    ELSE RETURN NEW; END IF;
    INSERT INTO vir_workflow_events(event_key,entity_type,entity_id,location_id,payload)
    VALUES(ev,'appointment',NEW.id::text,NEW.location_id,
      jsonb_build_object('status',NEW.status,'client_id',NEW.client_id,'employee_id',NEW.employee_id,'location_id',NEW.location_id,
        'start_time',NEW.start_time,'end_time',NEW.end_time,'booking_source',NEW.booking_source));
    RETURN NEW;
  END $$;
  DO $$ BEGIN
    IF to_regclass('public.appointments') IS NOT NULL THEN
      DROP TRIGGER IF EXISTS trg_vir_appointment_workflow_event ON appointments;
      CREATE TRIGGER trg_vir_appointment_workflow_event AFTER INSERT OR UPDATE OF status ON appointments
      FOR EACH ROW EXECUTE FUNCTION vir_capture_appointment_event();
    END IF;
  END $$;
 `).then(()=>undefined).catch(e=>{schemaPromise=null;throw e});
 await schemaPromise;
}

export async function profitEngine(params:{locationId?:string|null;from?:string;to?:string;targetMargin?:number}){
 await ensureVirWave2Schema();
 const locationId=params.locationId&&UUID_RE.test(params.locationId)?params.locationId:null;
 const from=/^\d{4}-\d{2}-\d{2}$/.test(String(params.from||''))?params.from:null;
 const to=/^\d{4}-\d{2}-\d{2}$/.test(String(params.to||''))?params.to:null;
 const target=clamp(num(params.targetMargin)||35,0,100);
 const {rows}=await db.query(`
  WITH recipe AS (
    SELECT r.service_id,
      SUM(r.default_quantity*(1+COALESCE(r.waste_percent,0)/100.0)*COALESCE(bl.unit_cost,bg.unit_cost,0))::numeric material_cost,
      COUNT(*) FILTER(WHERE r.active)::int material_lines
    FROM service_material_requirements r
    LEFT JOIN product_stock_balances bl ON bl.product_id=r.product_id AND bl.location_id=$1::uuid
    LEFT JOIN product_stock_balances bg ON bg.product_id=r.product_id AND bg.location_id IS NULL
    WHERE r.active=true GROUP BY r.service_id
  ), base AS (
    SELECT wi.service_id,s.name service_name,COALESCE(wi.quantity,1)::numeric qty,
      COALESCE(wi.line_total,wi.unit_price*COALESCE(wi.quantity,1),0)::numeric revenue,
      COALESCE(wi.duration_minutes,s.duration_minutes,30)::numeric duration_minutes,
      COALESCE(recipe.material_cost,0)::numeric material_unit_cost,COALESCE(recipe.material_lines,0)::int material_lines,
      COALESCE(NULLIF(to_jsonb(e)->>'hourly_wage','')::numeric,0)::numeric hourly_wage,
      COALESCE(NULLIF(to_jsonb(e)->>'commission_percent','')::numeric,0)::numeric commission_percent
    FROM work_order_items wi JOIN work_orders w ON w.id=wi.work_order_id JOIN services s ON s.id=wi.service_id
    LEFT JOIN employees e ON e.id=w.employee_id LEFT JOIN recipe ON recipe.service_id=wi.service_id
    WHERE wi.item_type='service' AND wi.service_id IS NOT NULL
      AND lower(COALESCE(w.status,''))='completed'
      AND ($1::uuid IS NULL OR w.location_id=$1::uuid)
      AND ($2::date IS NULL OR COALESCE(w.completed_at,w.closed_at,w.updated_at)::date >= $2::date)
      AND ($3::date IS NULL OR COALESCE(w.completed_at,w.closed_at,w.updated_at)::date <= $3::date)
  )
  SELECT service_id::text,service_name,COUNT(*)::int completed_lines,SUM(qty)::numeric service_quantity,
    ROUND(SUM(revenue),2)::numeric revenue,
    ROUND(SUM(material_unit_cost*qty),2)::numeric material_cost,
    ROUND(SUM((duration_minutes*qty/60.0)*hourly_wage),2)::numeric labor_cost,
    ROUND(SUM(revenue*commission_percent/100.0),2)::numeric commission_cost,
    ROUND(SUM(revenue-material_unit_cost*qty-(duration_minutes*qty/60.0)*hourly_wage-revenue*commission_percent/100.0),2)::numeric gross_profit,
    ROUND(CASE WHEN SUM(revenue)>0 THEN 100*SUM(revenue-material_unit_cost*qty-(duration_minutes*qty/60.0)*hourly_wage-revenue*commission_percent/100.0)/SUM(revenue) ELSE 0 END,2)::numeric margin_percent,
    ROUND(CASE WHEN SUM(duration_minutes*qty)>0 THEN SUM(revenue-material_unit_cost*qty-(duration_minutes*qty/60.0)*hourly_wage-revenue*commission_percent/100.0)/SUM(duration_minutes*qty) ELSE 0 END,2)::numeric profit_per_minute,
    MAX(material_lines)::int recipe_lines
  FROM base GROUP BY service_id,service_name ORDER BY gross_profit DESC,service_name
 `,[locationId,from,to]);
 const services=rows.map((r:any)=>({...r,revenue:num(r.revenue),material_cost:num(r.material_cost),labor_cost:num(r.labor_cost),commission_cost:num(r.commission_cost),gross_profit:num(r.gross_profit),margin_percent:num(r.margin_percent),profit_per_minute:num(r.profit_per_minute),below_target:num(r.margin_percent)<target,recipe_complete:num(r.recipe_lines)>0}));
 const summary=services.reduce((a:any,r:any)=>{a.revenue+=r.revenue;a.material_cost+=r.material_cost;a.labor_cost+=r.labor_cost;a.commission_cost+=r.commission_cost;a.gross_profit+=r.gross_profit;if(r.below_target)a.below_target+=1;if(!r.recipe_complete)a.missing_recipe+=1;return a},{revenue:0,material_cost:0,labor_cost:0,commission_cost:0,gross_profit:0,below_target:0,missing_recipe:0});
 summary.margin_percent=summary.revenue?Math.round(summary.gross_profit/summary.revenue*10000)/100:0;
 return{summary,services,target_margin_percent:target,cost_basis:'current_recipe_and_stock_unit_cost'};
}

export async function loadRecipes(serviceId?:string|null,locationId?:string|null){
 await ensureVirWave2Schema();
 const sid=serviceId&&UUID_RE.test(serviceId)?serviceId:null,lid=locationId&&UUID_RE.test(locationId)?locationId:null;
 const {rows}=await db.query(`
  SELECT r.id::text,r.service_id::text,s.name service_name,r.product_id::text,p.name product_name,
    r.default_quantity::numeric,r.unit,r.waste_percent::numeric,r.required,r.active,r.note,r.version,r.updated_by,r.updated_at,
    COALESCE(bl.unit_cost,bg.unit_cost,0)::numeric unit_cost,
    ROUND(r.default_quantity*(1+COALESCE(r.waste_percent,0)/100.0)*COALESCE(bl.unit_cost,bg.unit_cost,0),2)::numeric estimated_cost
  FROM service_material_requirements r JOIN services s ON s.id=r.service_id JOIN products p ON p.id=r.product_id
  LEFT JOIN product_stock_balances bl ON bl.product_id=r.product_id AND bl.location_id=$2::uuid
  LEFT JOIN product_stock_balances bg ON bg.product_id=r.product_id AND bg.location_id IS NULL
  WHERE ($1::uuid IS NULL OR r.service_id=$1::uuid) ORDER BY s.name,p.name`,[sid,lid]);
 return rows;
}

export async function replaceRecipe(serviceId:string,materials:any[],actor:string){
 if(!UUID_RE.test(serviceId))throw Object.assign(new Error('Érvénytelen szolgáltatásazonosító.'),{status:400});
 if(!Array.isArray(materials)||materials.length>100)throw Object.assign(new Error('A receptúra legfeljebb 100 anyagsort tartalmazhat.'),{status:400});
 await ensureVirWave2Schema();const cx=await db.connect();
 try{await cx.query('BEGIN');const exists=(await cx.query(`SELECT 1 FROM services WHERE id=$1::uuid AND COALESCE(is_active,true)=true`,[serviceId])).rows[0];if(!exists)throw Object.assign(new Error('A szolgáltatás nem található.'),{status:404});
  const seen=new Set<string>();
  for(const m of materials){const productId=String(m?.product_id||'').trim();if(!UUID_RE.test(productId)||seen.has(productId))throw Object.assign(new Error('Érvénytelen vagy duplikált termék a receptúrában.'),{status:400});seen.add(productId);const qty=num(m?.default_quantity);if(!(qty>0))throw Object.assign(new Error('Az anyagmennyiségnek pozitívnak kell lennie.'),{status:400});const waste=clamp(num(m?.waste_percent),0,100);
   await cx.query(`INSERT INTO service_material_requirements(service_id,product_id,default_quantity,unit,waste_percent,required,active,note,updated_by) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,true,$7,$8) ON CONFLICT(service_id,product_id) DO UPDATE SET default_quantity=EXCLUDED.default_quantity,unit=EXCLUDED.unit,waste_percent=EXCLUDED.waste_percent,required=EXCLUDED.required,active=true,note=EXCLUDED.note,updated_by=EXCLUDED.updated_by,version=service_material_requirements.version+1,updated_at=now()`,[serviceId,productId,qty,String(m?.unit||'db').slice(0,30),waste,m?.required!==false,String(m?.note||'').slice(0,500)||null,actor]);}
  if(seen.size)await cx.query(`UPDATE service_material_requirements SET active=false,updated_by=$2,version=version+1,updated_at=now() WHERE service_id=$1::uuid AND NOT(product_id=ANY($3::uuid[]))`,[serviceId,actor,Array.from(seen)]);else await cx.query(`UPDATE service_material_requirements SET active=false,updated_by=$2,version=version+1,updated_at=now() WHERE service_id=$1::uuid`,[serviceId,actor]);
  await cx.query('COMMIT');return loadRecipes(serviceId,null);
 }catch(e){await cx.query('ROLLBACK').catch(()=>undefined);throw e}finally{cx.release()}
}

async function fingerprint(value:any){return (await db.query(`SELECT encode(digest(convert_to($1::text,'UTF8'),'sha256'),'hex') hash`,[JSON.stringify(value)])).rows[0].hash as string}
function outputText(data:any){return String(data?.output_text||data?.output?.flatMap((x:any)=>x?.content||[]).find((x:any)=>x?.type==='output_text')?.text||'')}

export async function clientBrief(clientId:string,forceAi=false){
 if(!UUID_RE.test(clientId))throw Object.assign(new Error('Érvénytelen vendégazonosító.'),{status:400});await ensureVirWave2Schema();
 const client=(await db.query(`SELECT id::text,COALESCE(full_name,name,'Vendég') full_name,email,phone,location_id::text FROM clients WHERE id=$1::uuid`,[clientId])).rows[0];if(!client)throw Object.assign(new Error('A vendég nem található.'),{status:404});
 const [history,products,stats,risk]=await Promise.all([
  db.query(`SELECT a.id::text,a.start_time,a.status,e.full_name employee_name,array_remove(array_agg(DISTINCT s.name),NULL) services FROM appointments a LEFT JOIN employees e ON e.id=a.employee_id LEFT JOIN appointment_services aps ON aps.appointment_id=a.id LEFT JOIN services s ON s.id=aps.service_id WHERE a.client_id=$1::uuid GROUP BY a.id,e.full_name ORDER BY a.start_time DESC LIMIT 12`,[clientId]),
  db.query(`SELECT p.name,SUM(COALESCE(wi.quantity,1))::numeric quantity,MAX(COALESCE(w.closed_at,w.updated_at)) last_bought FROM work_order_items wi JOIN work_orders w ON w.id=wi.work_order_id JOIN products p ON p.id=wi.product_id WHERE w.client_id=$1::uuid AND wi.item_type='product' AND wi.product_id IS NOT NULL GROUP BY p.id,p.name ORDER BY quantity DESC LIMIT 8`,[clientId]),
  db.query(`SELECT COUNT(*) FILTER(WHERE start_time<now())::int visits,COUNT(*) FILTER(WHERE lower(COALESCE(status,'')) IN('cancelled','canceled'))::int cancellations,COUNT(*) FILTER(WHERE lower(COALESCE(status,'')) IN('no_show','no-show','noshow'))::int no_shows,MAX(start_time) FILTER(WHERE start_time<now()) last_visit FROM appointments WHERE client_id=$1::uuid`,[clientId]),
  db.query(`SELECT score,risk_level,calculated_at FROM booking_no_show_scores WHERE client_id=$1::uuid`,[clientId]).catch(()=>({rows:[]} as any)),
 ]);
 const source={client:{id:client.id,full_name:client.full_name},stats:stats.rows[0]||{},recent_visits:history.rows.map((x:any)=>({date:x.start_time,status:x.status,employee_name:x.employee_name,services:x.services})),top_products:products.rows,risk:risk.rows[0]||null};
 const fp=await fingerprint(source);const cached=(await db.query(`SELECT brief,ai_used,model,generated_at FROM vir_client_brief_cache WHERE client_id=$1::uuid AND source_fingerprint=$2`,[clientId,fp])).rows[0];if(cached&&!forceAi)return{source,...cached,cache_hit:true};
 const fallback={summary:`${num(source.stats.visits)} korábbi látogatás; legutóbbi látogatás: ${source.stats.last_visit?new Date(source.stats.last_visit).toLocaleDateString('hu-HU'):'nincs adat'}.`,preferences:Array.from(new Set(history.rows.flatMap((x:any)=>Array.isArray(x.services)?x.services:[]))).slice(0,5),rebooking_hint:'A következő időpontot a korábbi szolgáltatások és látogatási ritmus alapján érdemes egyeztetni.',upsell_opportunities:products.rows.slice(0,3).map((x:any)=>x.name),attention:risk.rows[0]?`No-show kockázat: ${risk.rows[0].score}/100 (${risk.rows[0].risk_level}).`:''};
 let brief:any=fallback,aiUsed=false,model:string|null=null;const key=String(process.env.OPENAI_API_KEY||'').trim();if(key){try{model=process.env.VIR_CLIENT_BRIEF_MODEL||process.env.OPENAI_MODEL||'gpt-5-mini';const response=await axios.post('https://api.openai.com/v1/responses',{model,store:false,max_output_tokens:900,text:{format:{type:'json_schema',name:'vir_client_brief',strict:true,schema:{type:'object',properties:{summary:{type:'string'},preferences:{type:'array',items:{type:'string'}},rebooking_hint:{type:'string'},upsell_opportunities:{type:'array',items:{type:'string'}},attention:{type:'string'}},required:['summary','preferences','rebooking_hint','upsell_opportunities','attention'],additionalProperties:false}}},input:[{role:'system',content:[{type:'input_text',text:'Készíts rövid magyar szépségszalon ügyfél-briefet kizárólag a kapott tranzakciós adatokból. Ne következtess egészségre, érzékeny tulajdonságokra vagy magánéletre. Ne találj ki kezelést vagy preferenciát. Upsell csak korábban vásárolt termékből vagy visszatérő szolgáltatásból javasolható. Összefoglaló max 450 karakter.'}]},{role:'user',content:[{type:'input_text',text:JSON.stringify(source)}]}]},{headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},timeout:12000});brief=JSON.parse(outputText(response.data).trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));aiUsed=true}catch(e:any){console.warn('[vir-wave2] client brief AI fallback',e?.response?.status||e?.message||e)}}
 await db.query(`INSERT INTO vir_client_brief_cache(client_id,source_fingerprint,brief,ai_used,model,generated_at) VALUES($1::uuid,$2,$3::jsonb,$4,$5,now()) ON CONFLICT(client_id) DO UPDATE SET source_fingerprint=EXCLUDED.source_fingerprint,brief=EXCLUDED.brief,ai_used=EXCLUDED.ai_used,model=EXCLUDED.model,generated_at=now()`,[clientId,fp,JSON.stringify(brief),aiUsed,model]);return{source,brief,ai_used:aiUsed,model,cache_hit:false};
}

function readPath(payload:any,path:string){return path.split('.').reduce((x:any,k)=>x==null?undefined:x[k],payload)}
function conditionsMatch(payload:any,conditions:any){if(!conditions||typeof conditions!=='object'||Array.isArray(conditions))return true;for(const [path,rule] of Object.entries(conditions)){const actual=readPath(payload,path);if(rule&&typeof rule==='object'&&!Array.isArray(rule)){const r:any=rule;if('eq'in r&&actual!==r.eq)return false;if('gte'in r&&num(actual)<num(r.gte))return false;if('lte'in r&&num(actual)>num(r.lte))return false;if('in'in r&&Array.isArray(r.in)&&!r.in.includes(actual))return false;if('contains'in r&&!String(actual??'').includes(String(r.contains)))return false}else if(actual!==rule)return false}return true}

async function materializeAction(event:any,rule:any,action:any,index:number){const type=String(action?.type||'workflow_task').slice(0,80);const payload={...action,event:{id:event.id,event_key:event.event_key,entity_type:event.entity_type,entity_id:event.entity_id,payload:event.payload}};const status=rule.mode==='assisted'?'approved':'prepared';const row=(await db.query(`INSERT INTO vir_workflow_actions(event_id,rule_id,action_index,action_type,entity_type,entity_id,location_id,status,payload) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7::uuid,$8,$9::jsonb) ON CONFLICT(event_id,rule_id,action_index) DO UPDATE SET payload=EXCLUDED.payload RETURNING *`,[event.id,rule.id,index,type,event.entity_type,event.entity_id,event.location_id,status,JSON.stringify(payload)])).rows[0];
 if(type==='booking_automation'&&(await db.query(`SELECT to_regclass('public.booking_automation_queue') IS NOT NULL ok`)).rows[0]?.ok){const dedupe=`workflow:${event.id}:${rule.id}:${index}`;await db.query(`INSERT INTO booking_automation_queue(dedupe_key,action_type,entity_type,entity_id,location_id,status,priority,payload,available_at,created_by,updated_by) VALUES($1,$2,$3,NULLIF($4,'')::uuid,$5::uuid,$6,$7,$8::jsonb,now(),'vir-workflow','vir-workflow') ON CONFLICT(dedupe_key) DO NOTHING`,[dedupe,String(action.action_type||'workflow_task').slice(0,80),event.entity_type,UUID_RE.test(String(event.entity_id||''))?event.entity_id:null,event.location_id,status,clamp(Math.round(num(action.priority)||50),0,100),JSON.stringify(payload)]).catch(()=>undefined)}return row}

export async function processWorkflowEvents(limit=50){await ensureVirWave2Schema();const events=(await db.query(`UPDATE vir_workflow_events SET status='processing',attempts=attempts+1 WHERE id IN(SELECT id FROM vir_workflow_events WHERE status IN('pending','failed') AND attempts<5 ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED) RETURNING *`,[clamp(Math.round(limit),1,200)])).rows;let actions=0,failed=0;for(const event of events){try{const rules=(await db.query(`SELECT * FROM vir_workflow_rules WHERE active=true AND (event_key=$1 OR event_key='*') AND (location_id IS NULL OR location_id=$2::uuid) ORDER BY created_at`,[event.event_key,event.location_id])).rows;for(const rule of rules){if(!conditionsMatch(event.payload,rule.conditions))continue;if(num(rule.cooldown_minutes)>0){const recent=(await db.query(`SELECT 1 FROM vir_workflow_actions a JOIN vir_workflow_events e ON e.id=a.event_id WHERE a.rule_id=$1::uuid AND e.entity_type=$2 AND e.entity_id IS NOT DISTINCT FROM $3 AND a.created_at>now()-($4::text||' minutes')::interval LIMIT 1`,[rule.id,event.entity_type,event.entity_id,rule.cooldown_minutes])).rows[0];if(recent)continue}const list=Array.isArray(rule.actions)?rule.actions:[];for(let i=0;i<list.length;i++){await materializeAction(event,rule,list[i],i);actions++}}await db.query(`UPDATE vir_workflow_events SET status='processed',processed_at=now(),last_error=NULL WHERE id=$1::uuid`,[event.id])}catch(e:any){failed++;await db.query(`UPDATE vir_workflow_events SET status='failed',last_error=$2 WHERE id=$1::uuid`,[event.id,String(e?.message||e).slice(0,1000)]).catch(()=>undefined)}}return{events:events.length,actions,failed}}

export function startVirWorkflowWorker(){if(workerStarted||process.env.NODE_ENV==='test'||process.env.VIR_WORKFLOW_WORKER_ENABLED==='0')return;workerStarted=true;const tick=()=>processWorkflowEvents(80).catch(e=>console.warn('[vir-workflow] worker',e?.message||e));setTimeout(tick,15_000).unref?.();setInterval(tick,60_000).unref?.()}
