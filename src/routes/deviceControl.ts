import {Router,Response} from 'express';
import {createHash,createHmac,randomUUID,timingSafeEqual} from 'crypto';
import db from '../db';
import {AuthRequest} from '../middleware/auth';
import {parseRoleKeys} from '../security/roles';
import {ensureHrV2} from '../hr/ensureHrV2';

const router=Router();
const OP_ROLES=new Set(['admin','manager','location_manager','salon_manager','receptionist']);
const GLOBAL_ROLES=new Set(['admin','manager']);
const MANAGE_ROLES=new Set(['admin','manager','location_manager','salon_manager']);
const ADAPTERS=new Set(['SIMULATOR','LOCAL_BRIDGE','CLOUD_API']);
const TX_STATUSES=new Set(['APPROVED','DECLINED','CANCELLED','ERROR']);
const money=(v:unknown)=>{const n=Number(v??0);return Number.isFinite(n)?Math.round(n*100)/100:0};
const actor=(req:AuthRequest)=>req.user?.email||String(req.user?.id||'');
const roles=(req:AuthRequest)=>parseRoleKeys(req.user?.role);
const hasRole=(req:AuthRequest,set:Set<string>)=>roles(req).some(r=>set.has(r));
const normalizeUid=(v:unknown)=>String(v??'').trim().toUpperCase().replace(/[^0-9A-Z]/g,'');
const uidHash=(v:string)=>createHash('sha256').update(v,'utf8').digest('hex');

async function ensureSchema(){
 await ensureHrV2();
 await db.query(`
  CREATE TABLE IF NOT EXISTS vir_payment_terminal_devices(
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(),location_id text NOT NULL,name text NOT NULL,
   adapter_type text NOT NULL DEFAULT 'SIMULATOR',terminal_reference text,bridge_url text,
   secret_env_key text,currency varchar(3) NOT NULL DEFAULT 'HUF',active boolean NOT NULL DEFAULT true,
   is_default boolean NOT NULL DEFAULT false,created_by text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS vir_payment_terminal_devices_location_idx ON vir_payment_terminal_devices(location_id,active,is_default);
  CREATE TABLE IF NOT EXISTS vir_payment_terminal_transactions(
   id uuid PRIMARY KEY,terminal_id uuid NOT NULL REFERENCES vir_payment_terminal_devices(id),location_id text NOT NULL,
   source_type text NOT NULL,source_id text,source_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
   amount numeric(14,2) NOT NULL CHECK(amount>0),currency varchar(3) NOT NULL DEFAULT 'HUF',status text NOT NULL DEFAULT 'CREATED',
   idempotency_key text NOT NULL UNIQUE,external_transaction_id text,approval_code text,receipt_reference text,error_message text,
   created_by text,created_at timestamptz NOT NULL DEFAULT now(),sent_at timestamptz,completed_at timestamptz,consumed_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS vir_payment_terminal_transactions_source_idx ON vir_payment_terminal_transactions(source_type,source_id,created_at DESC);
  CREATE INDEX IF NOT EXISTS vir_payment_terminal_transactions_location_idx ON vir_payment_terminal_transactions(location_id,created_at DESC);
  CREATE TABLE IF NOT EXISTS vir_staff_rfid_cards(
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(),employee_id text NOT NULL,location_id text NOT NULL,
   uid_hash char(64) NOT NULL UNIQUE,uid_last4 varchar(4),label text,active boolean NOT NULL DEFAULT true,
   assigned_by text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS vir_staff_rfid_cards_employee_idx ON vir_staff_rfid_cards(employee_id,active);
  CREATE TABLE IF NOT EXISTS vir_staff_rfid_events(
   id bigserial PRIMARY KEY,card_id uuid REFERENCES vir_staff_rfid_cards(id),employee_id text NOT NULL,location_id text NOT NULL,
   event_type text NOT NULL CHECK(event_type IN('CHECK_IN','CHECK_OUT','REJECTED','DUPLICATE')),
   occurred_at timestamptz NOT NULL DEFAULT now(),reader_source text NOT NULL DEFAULT 'RECEPTION_USB_KEYBOARD',actor_user text,note text
  );
  CREATE INDEX IF NOT EXISTS vir_staff_rfid_events_employee_idx ON vir_staff_rfid_events(employee_id,occurred_at DESC);
 `);
}

function requireOperator(req:AuthRequest,res:Response){if(!hasRole(req,OP_ROLES)){res.status(403).json({message:'Ehhez a művelethez recepciós vagy vezetői jogosultság szükséges.'});return false}return true}
function scopedLocation(req:AuthRequest,res:Response,requested?:unknown){
 const wanted=String(requested??req.query.location_id??req.body?.location_id??'').trim();
 if(hasRole(req,GLOBAL_ROLES)){if(!wanted){res.status(400).json({message:'Válasszon telephelyet.'});return null}return wanted}
 const own=String(req.user?.location_id??'').trim();
 if(!own){res.status(403).json({message:'A felhasználóhoz nincs telephely rendelve.'});return null}
 if(wanted&&wanted!==own){res.status(403).json({message:'Másik telephely eszközei nem kezelhetők.'});return null}
 return own;
}
async function terminalById(id:string,locationId:string){return (await db.query(`SELECT * FROM vir_payment_terminal_devices WHERE id=$1::uuid AND location_id=$2 AND active=true`,[id,locationId])).rows[0]||null}
async function terminalFor(locationId:string,id?:unknown){
 if(id)return terminalById(String(id),locationId);
 return (await db.query(`SELECT * FROM vir_payment_terminal_devices WHERE location_id=$1 AND active=true ORDER BY is_default DESC,created_at LIMIT 1`,[locationId])).rows[0]||null;
}
function publicTerminal(t:any){if(!t)return null;const{secret_env_key,...safe}=t;return{...safe,secret_configured:Boolean(secret_env_key&&process.env[String(secret_env_key)])}}

async function workOrderSource(sourceId:string,requestedAmount:unknown){
 const q=await db.query(`SELECT w.id::text id,w.location_id::text location_id,w.work_order_number,
  COALESCE((SELECT SUM(COALESCE(i.line_total,0)) FROM work_order_items i WHERE i.work_order_id=w.id),0)::numeric gross_total,
  COALESCE(NULLIF(to_jsonb(w)->>'discount_amount','')::numeric,0)::numeric discount_amount,
  COALESCE(NULLIF(to_jsonb(w)->>'tip_amount','')::numeric,0)::numeric tip_amount,
  COALESCE((SELECT SUM(COALESCE(p.amount,0)) FROM work_order_payments p WHERE p.work_order_id=w.id),0)::numeric paid_total,
  NULLIF(to_jsonb(w)->>'financial_closed_at','')::timestamptz financial_closed_at
  FROM work_orders w WHERE w.id::text=$1 LIMIT 1`,[sourceId]);
 const w=q.rows[0];if(!w)throw Object.assign(new Error('A munkalap nem található.'),{status:404});
 if(w.financial_closed_at)throw Object.assign(new Error('A munkalap pénzügyileg már lezárt.'),{status:409});
 const remaining=money(Number(w.gross_total)-Number(w.discount_amount)+Number(w.tip_amount)-Number(w.paid_total));
 if(!(remaining>0))throw Object.assign(new Error('A munkalapon nincs fizetendő összeg.'),{status:409});
 const requested=money(requestedAmount);const amount=requested>0?Math.min(requested,remaining):remaining;
 return{location_id:String(w.location_id),amount,snapshot:{work_order_number:w.work_order_number,gross_total:money(w.gross_total),discount_amount:money(w.discount_amount),tip_amount:money(w.tip_amount),paid_total:money(w.paid_total),remaining_total:remaining}};
}

async function retailCartSource(locationId:string,items:any[]){
 if(!Array.isArray(items)||!items.length)throw Object.assign(new Error('A termékkosár üres.'),{status:400});
 const normalized:any[]=[];
 for(const item of items){
  const productId=String(item?.product_id||item?.id||'').trim(),quantity=Math.max(0,Number(item?.quantity||0));
  if(!productId||!(quantity>0))throw Object.assign(new Error('Minden termékhez pozitív mennyiség szükséges.'),{status:400});
  const p=(await db.query(`SELECT p.id::text id,p.name,COALESCE(NULLIF(to_jsonb(p)->>'retail_price_gross','')::numeric,NULLIF(to_jsonb(p)->>'sale_price','')::numeric,NULLIF(to_jsonb(p)->>'price','')::numeric,0)::numeric price FROM products p WHERE p.id::text=$1 AND COALESCE(NULLIF(to_jsonb(p)->>'is_active','')::boolean,true)=true LIMIT 1`,[productId])).rows[0];
  if(!p)throw Object.assign(new Error('Egy kiválasztott termék nem található vagy inaktív.'),{status:400});
  const price=money(p.price),gross=money(price*quantity);normalized.push({product_id:p.id,product_name:p.name,quantity,unit_price:price,gross_amount:gross});
 }
 const amount=money(normalized.reduce((s,x)=>s+x.gross_amount,0));if(!(amount>0))throw Object.assign(new Error('A kosár fizetendő összege nulla.'),{status:400});
 return{location_id:locationId,amount,snapshot:{items:normalized,item_count:normalized.length}};
}

router.use(async(_req,_res,next)=>{try{await ensureSchema();next()}catch(e){next(e)}});

router.get('/readiness',async(req:AuthRequest,res,next)=>{try{if(!requireOperator(req,res))return;const loc=String(req.query.location_id||req.user?.location_id||'').trim();const terminals=loc?(await db.query(`SELECT * FROM vir_payment_terminal_devices WHERE location_id=$1 AND active=true ORDER BY is_default DESC,name`,[loc])).rows:[];res.json({ok:true,rfid:{keyboard_wedge_ready:true,storage:'sha256-hash',timesheet_sync:true},payment_terminal:{configured:terminals.length>0,terminals:terminals.map(publicTerminal),live_ready:terminals.some((t:any)=>t.adapter_type!=='SIMULATOR'&&t.bridge_url&&t.secret_env_key&&process.env[String(t.secret_env_key)]),supported_adapters:['SIMULATOR','LOCAL_BRIDGE','CLOUD_API'],bridge_contract:{request:'POST {bridge_url}/payments',signature:'HMAC-SHA256 of JSON result in x-vir-device-signature; secret comes from server environment'}}})}catch(e){next(e)}});

router.get('/payment-terminals',async(req:AuthRequest,res,next)=>{try{if(!requireOperator(req,res))return;const requested=String(req.query.location_id||'').trim();if(hasRole(req,GLOBAL_ROLES)&&!requested){const rows=(await db.query(`SELECT * FROM vir_payment_terminal_devices ORDER BY location_id,is_default DESC,name`)).rows;return res.json(rows.map(publicTerminal))}const loc=scopedLocation(req,res,requested);if(!loc)return;res.json((await db.query(`SELECT * FROM vir_payment_terminal_devices WHERE location_id=$1 ORDER BY is_default DESC,name`,[loc])).rows.map(publicTerminal))}catch(e){next(e)}});

router.post('/payment-terminals',async(req:AuthRequest,res,next)=>{try{if(!requireOperator(req,res))return;if(!hasRole(req,MANAGE_ROLES))return res.status(403).json({message:'Terminálbeállítást csak vezető módosíthat.'});const loc=scopedLocation(req,res,req.body?.location_id);if(!loc)return;const b=req.body||{},adapter=String(b.adapter_type||'SIMULATOR').toUpperCase();if(!ADAPTERS.has(adapter))return res.status(400).json({message:'Ismeretlen terminál adapter.'});const name=String(b.name||'Bankkártya terminál').trim();if(adapter!=='SIMULATOR'&&!String(b.bridge_url||'').trim())return res.status(400).json({message:'Éles adapterhez bridge/API URL szükséges.'});if(b.is_default)await db.query(`UPDATE vir_payment_terminal_devices SET is_default=false,updated_at=now() WHERE location_id=$1`,[loc]);let row;if(b.id){row=(await db.query(`UPDATE vir_payment_terminal_devices SET name=$3,adapter_type=$4,terminal_reference=$5,bridge_url=$6,secret_env_key=$7,currency=$8,active=COALESCE($9,active),is_default=COALESCE($10,is_default),updated_at=now() WHERE id=$1::uuid AND location_id=$2 RETURNING *`,[String(b.id),loc,name,adapter,String(b.terminal_reference||'')||null,String(b.bridge_url||'').replace(/\/$/,'')||null,String(b.secret_env_key||'')||null,String(b.currency||'HUF').toUpperCase(),b.active,b.is_default])).rows[0]}else{row=(await db.query(`INSERT INTO vir_payment_terminal_devices(location_id,name,adapter_type,terminal_reference,bridge_url,secret_env_key,currency,active,is_default,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,COALESCE($8,true),COALESCE($9,false),$10) RETURNING *`,[loc,name,adapter,String(b.terminal_reference||'')||null,String(b.bridge_url||'').replace(/\/$/,'')||null,String(b.secret_env_key||'')||null,String(b.currency||'HUF').toUpperCase(),b.active,b.is_default,actor(req)])).rows[0]}if(!row)return res.status(404).json({message:'A terminál nem található.'});res.status(b.id?200:201).json(publicTerminal(row))}catch(e){next(e)}});

router.post('/payments/intent',async(req:AuthRequest,res,next)=>{try{if(!requireOperator(req,res))return;const b=req.body||{},sourceType=String(b.source_type||'').toUpperCase();let source:any,sourceId=String(b.source_id||'').trim();if(sourceType==='WORK_ORDER'){if(!sourceId)return res.status(400).json({message:'Munkalapazonosító szükséges.'});source=await workOrderSource(sourceId,b.requested_amount)}else if(sourceType==='RETAIL_CART'){const loc=scopedLocation(req,res,b.location_id);if(!loc)return;source=await retailCartSource(loc,b.items);sourceId=String(b.cart_key||randomUUID())}else return res.status(400).json({message:'A támogatott forrás WORK_ORDER vagy RETAIL_CART.'});const loc=scopedLocation(req,res,source.location_id);if(!loc)return;const terminal=await terminalFor(loc,b.terminal_id);if(!terminal)return res.status(409).json({message:'Ehhez a telephelyhez nincs aktív bankkártya-terminál beállítva.'});const key=String(req.headers['idempotency-key']||b.idempotency_key||randomUUID()).trim();const existing=(await db.query(`SELECT * FROM vir_payment_terminal_transactions WHERE idempotency_key=$1`,[key])).rows[0];if(existing)return res.json({transaction:existing,terminal:publicTerminal(terminal),reused:true});const id=randomUUID();const tx=(await db.query(`INSERT INTO vir_payment_terminal_transactions(id,terminal_id,location_id,source_type,source_id,source_snapshot,amount,currency,status,idempotency_key,created_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,'CREATED',$9,$10) RETURNING *`,[id,terminal.id,loc,sourceType,sourceId,JSON.stringify(source.snapshot),source.amount,String(terminal.currency||'HUF'),key,actor(req)])).rows[0];res.status(201).json({transaction:tx,terminal:publicTerminal(terminal),command:{adapter_type:terminal.adapter_type,bridge_url:terminal.bridge_url,payload:{transaction_id:id,amount:money(tx.amount),currency:tx.currency,reference:`VIR-${id.slice(0,8)}`,source_type:sourceType,source_id:sourceId}}})}catch(e:any){if(e?.status)return res.status(e.status).json({message:e.message});next(e)}});

router.post('/payments/:id/simulate',async(req:AuthRequest,res,next)=>{try{if(!requireOperator(req,res))return;const q=await db.query(`SELECT x.*,d.adapter_type FROM vir_payment_terminal_transactions x JOIN vir_payment_terminal_devices d ON d.id=x.terminal_id WHERE x.id=$1::uuid`,[req.params.id]);const tx=q.rows[0];if(!tx)return res.status(404).json({message:'A tranzakció nem található.'});const loc=scopedLocation(req,res,tx.location_id);if(!loc)return;if(tx.adapter_type!=='SIMULATOR')return res.status(409).json({message:'Ez nem teszt terminál.'});const row=(await db.query(`UPDATE vir_payment_terminal_transactions SET status='APPROVED',sent_at=COALESCE(sent_at,now()),completed_at=now(),external_transaction_id=COALESCE(external_transaction_id,$2),approval_code=COALESCE(approval_code,'SIM-OK') WHERE id=$1::uuid AND status IN('CREATED','SENT') RETURNING *`,[req.params.id,`SIM-${Date.now()}`])).rows[0]||tx;res.json(row)}catch(e){next(e)}});

router.post('/payments/:id/result',async(req:AuthRequest,res,next)=>{try{if(!requireOperator(req,res))return;const q=await db.query(`SELECT x.*,d.secret_env_key,d.adapter_type FROM vir_payment_terminal_transactions x JOIN vir_payment_terminal_devices d ON d.id=x.terminal_id WHERE x.id=$1::uuid`,[req.params.id]);const tx=q.rows[0];if(!tx)return res.status(404).json({message:'A tranzakció nem található.'});const loc=scopedLocation(req,res,tx.location_id);if(!loc)return;if(tx.adapter_type==='SIMULATOR')return res.status(409).json({message:'Teszt terminálhoz a simulate végpont használható.'});const secret=tx.secret_env_key?process.env[String(tx.secret_env_key)]:'';if(!secret)return res.status(503).json({message:'A terminál aláírási titka nincs konfigurálva a szerveren.'});const signature=String(req.headers['x-vir-device-signature']||'').trim().toLowerCase(),canonical=JSON.stringify(req.body||{}),expected=createHmac('sha256',secret).update(canonical).digest('hex');const a=Buffer.from(signature),bfr=Buffer.from(expected);if(a.length!==bfr.length||!timingSafeEqual(a,bfr))return res.status(401).json({message:'Érvénytelen terminál-aláírás.'});const status=String(req.body?.status||'').toUpperCase();if(!TX_STATUSES.has(status))return res.status(400).json({message:'Érvénytelen terminál státusz.'});if(money(req.body?.amount)!==money(tx.amount)||String(req.body?.currency||'').toUpperCase()!==String(tx.currency).toUpperCase())return res.status(409).json({message:'A terminál eredményének összege vagy pénzneme eltér a VIR tranzakciótól.'});const row=(await db.query(`UPDATE vir_payment_terminal_transactions SET status=$2,sent_at=COALESCE(sent_at,now()),completed_at=now(),external_transaction_id=$3,approval_code=$4,receipt_reference=$5,error_message=$6 WHERE id=$1::uuid RETURNING *`,[req.params.id,status,String(req.body?.external_transaction_id||'')||null,String(req.body?.approval_code||'')||null,String(req.body?.receipt_reference||'')||null,String(req.body?.error_message||'')||null])).rows[0];res.json(row)}catch(e){next(e)}});

router.get('/payments/recent',async(req:AuthRequest,res,next)=>{try{if(!requireOperator(req,res))return;const loc=scopedLocation(req,res,req.query.location_id);if(!loc)return;res.json((await db.query(`SELECT x.*,d.name terminal_name,d.adapter_type FROM vir_payment_terminal_transactions x JOIN vir_payment_terminal_devices d ON d.id=x.terminal_id WHERE x.location_id=$1 ORDER BY x.created_at DESC LIMIT 100`,[loc])).rows)}catch(e){next(e)}});

router.get('/rfid/cards',async(req:AuthRequest,res,next)=>{try{if(!requireOperator(req,res))return;const loc=scopedLocation(req,res,req.query.location_id);if(!loc)return;res.json((await db.query(`SELECT c.id,c.employee_id,c.location_id,c.uid_last4,c.label,c.active,c.created_at,e.full_name,p.name position_name FROM vir_staff_rfid_cards c JOIN employees e ON e.id::text=c.employee_id LEFT JOIN hr_positions p ON p.id=e.position_id WHERE c.location_id=$1 ORDER BY c.active DESC,e.full_name`,[loc])).rows)}catch(e){next(e)}});

router.post('/rfid/cards',async(req:AuthRequest,res,next)=>{try{if(!requireOperator(req,res))return;const loc=scopedLocation(req,res,req.body?.location_id);if(!loc)return;const uid=normalizeUid(req.body?.uid),employeeId=String(req.body?.employee_id||'').trim();if(uid.length<4||!employeeId)return res.status(400).json({message:'Munkatárs és legalább 4 karakteres RFID UID szükséges.'});const employee=(await db.query(`SELECT id::text,full_name,location_id::text FROM employees WHERE id::text=$1 AND COALESCE(active,true)=true`,[employeeId])).rows[0];if(!employee)return res.status(404).json({message:'A munkatárs nem található vagy inaktív.'});if(!hasRole(req,GLOBAL_ROLES)&&String(employee.location_id||'')!==loc)return res.status(403).json({message:'A munkatárs másik telephelyhez tartozik.'});const hash=uidHash(uid);const existing=(await db.query(`SELECT id,employee_id FROM vir_staff_rfid_cards WHERE uid_hash=$1`,[hash])).rows[0];if(existing&&String(existing.employee_id)!==employeeId)return res.status(409).json({message:'Ez az RFID-kártya már másik munkatárshoz van rendelve.'});const row=(await db.query(`INSERT INTO vir_staff_rfid_cards(employee_id,location_id,uid_hash,uid_last4,label,active,assigned_by) VALUES($1,$2,$3,$4,$5,true,$6) ON CONFLICT(uid_hash) DO UPDATE SET employee_id=EXCLUDED.employee_id,location_id=EXCLUDED.location_id,label=EXCLUDED.label,active=true,updated_at=now() RETURNING id,employee_id,location_id,uid_last4,label,active,created_at`,[employeeId,loc,hash,uid.slice(-4),String(req.body?.label||'RFID kártya'),actor(req)])).rows[0];res.status(201).json({...row,full_name:employee.full_name})}catch(e){next(e)}});

router.patch('/rfid/cards/:id',async(req:AuthRequest,res,next)=>{try{if(!requireOperator(req,res))return;const current=(await db.query(`SELECT * FROM vir_staff_rfid_cards WHERE id=$1::uuid`,[req.params.id])).rows[0];if(!current)return res.status(404).json({message:'Az RFID-kártya nem található.'});const loc=scopedLocation(req,res,current.location_id);if(!loc)return;const row=(await db.query(`UPDATE vir_staff_rfid_cards SET active=COALESCE($2,active),label=COALESCE($3,label),updated_at=now() WHERE id=$1::uuid RETURNING id,employee_id,location_id,uid_last4,label,active,created_at`,[req.params.id,req.body?.active,req.body?.label==null?null:String(req.body.label)])).rows[0];res.json(row)}catch(e){next(e)}});

router.post('/rfid/scan',async(req:AuthRequest,res,next)=>{const client=await db.connect();try{if(!requireOperator(req,res))return;const loc=scopedLocation(req,res,req.body?.location_id);if(!loc)return;const uid=normalizeUid(req.body?.uid);if(uid.length<4)return res.status(400).json({message:'Érvénytelen RFID UID.'});const card=(await client.query(`SELECT c.*,e.full_name,p.name position_name FROM vir_staff_rfid_cards c JOIN employees e ON e.id::text=c.employee_id LEFT JOIN hr_positions p ON p.id=e.position_id WHERE c.uid_hash=$1 AND c.active=true`,[uidHash(uid)])).rows[0];if(!card){await client.query(`INSERT INTO vir_staff_rfid_events(employee_id,location_id,event_type,actor_user,note) VALUES('UNKNOWN',$1,'REJECTED',$2,'Ismeretlen RFID-kártya')`,[loc,actor(req)]);return res.status(404).json({message:'Ismeretlen RFID-kártya. Előbb rendelje munkatárshoz.'})}if(String(card.location_id)!==loc)return res.status(403).json({message:'Ez az RFID-kártya másik telephelyhez tartozik.'});const recent=(await client.query(`SELECT event_type,occurred_at FROM vir_staff_rfid_events WHERE card_id=$1 AND occurred_at>now()-interval '3 seconds' ORDER BY occurred_at DESC LIMIT 1`,[card.id])).rows[0];if(recent){await client.query(`INSERT INTO vir_staff_rfid_events(card_id,employee_id,location_id,event_type,actor_user,note) VALUES($1,$2,$3,'DUPLICATE',$4,'3 másodpercen belüli ismételt olvasás')`,[card.id,card.employee_id,loc,actor(req)]);return res.status(202).json({ok:true,duplicate:true,employee:{id:card.employee_id,full_name:card.full_name,position_name:card.position_name},event_type:recent.event_type})}await client.query('BEGIN');const ts=(await client.query(`SELECT * FROM timesheets WHERE employee_id::text=$1 AND work_date=(now() AT TIME ZONE 'Europe/Budapest')::date FOR UPDATE`,[card.employee_id])).rows[0];let eventType:'CHECK_IN'|'CHECK_OUT';let timesheet:any;if(!ts||!ts.clock_in){eventType='CHECK_IN';timesheet=(await client.query(`INSERT INTO timesheets(employee_id,location_id,work_date,clock_in,clock_out,break_minutes,regular_minutes,overtime_minutes,status,note) VALUES($1,$2,(now() AT TIME ZONE 'Europe/Budapest')::date,now(),NULL,0,0,0,'submitted','RFID recepciós beléptetés') ON CONFLICT(employee_id,work_date) DO UPDATE SET location_id=EXCLUDED.location_id,clock_in=COALESCE(timesheets.clock_in,EXCLUDED.clock_in),status='submitted',note=COALESCE(timesheets.note,'RFID recepciós beléptetés'),updated_at=now() RETURNING *`,[card.employee_id,loc])).rows[0]}else if(!ts.clock_out){eventType='CHECK_OUT';timesheet=(await client.query(`UPDATE timesheets SET clock_out=now(),regular_minutes=LEAST(480,GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (now()-clock_in))/60)-COALESCE(break_minutes,0)))::int,overtime_minutes=GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (now()-clock_in))/60)-COALESCE(break_minutes,0)-480)::int,status='submitted',note=COALESCE(note,'RFID recepciós kiléptetés'),updated_at=now() WHERE id=$1 RETURNING *`,[ts.id])).rows[0]}else{await client.query('ROLLBACK');return res.status(409).json({message:'A munkatárs mai jelenléti sora már lezárt. Újranyitást a HR jelenléti felületen lehet végezni.',employee:{id:card.employee_id,full_name:card.full_name},timesheet:ts})}await client.query(`INSERT INTO vir_staff_rfid_events(card_id,employee_id,location_id,event_type,actor_user) VALUES($1,$2,$3,$4,$5)`,[card.id,card.employee_id,loc,eventType,actor(req)]);await client.query('COMMIT');res.json({ok:true,event_type:eventType,employee:{id:card.employee_id,full_name:card.full_name,position_name:card.position_name},timesheet})}catch(e){await client.query('ROLLBACK').catch(()=>undefined);next(e)}finally{client.release()}});

router.get('/rfid/presence',async(req:AuthRequest,res,next)=>{try{if(!requireOperator(req,res))return;const loc=scopedLocation(req,res,req.query.location_id);if(!loc)return;const rows=(await db.query(`SELECT e.id::text employee_id,e.full_name,p.name position_name,t.clock_in,t.clock_out,t.status,CASE WHEN t.clock_in IS NOT NULL AND t.clock_out IS NULL THEN true ELSE false END present,c.uid_last4,c.label card_label FROM employees e LEFT JOIN hr_positions p ON p.id=e.position_id LEFT JOIN timesheets t ON t.employee_id=e.id AND t.work_date=(now() AT TIME ZONE 'Europe/Budapest')::date LEFT JOIN vir_staff_rfid_cards c ON c.employee_id=e.id::text AND c.location_id=$1 AND c.active=true WHERE e.location_id::text=$1 AND COALESCE(e.active,true)=true ORDER BY present DESC,e.full_name`,[loc])).rows;res.json(rows)}catch(e){next(e)}});

router.get('/rfid/events',async(req:AuthRequest,res,next)=>{try{if(!requireOperator(req,res))return;const loc=scopedLocation(req,res,req.query.location_id);if(!loc)return;res.json((await db.query(`SELECT x.*,e.full_name FROM vir_staff_rfid_events x LEFT JOIN employees e ON e.id::text=x.employee_id WHERE x.location_id=$1 ORDER BY x.occurred_at DESC LIMIT 100`,[loc])).rows)}catch(e){next(e)}});

export default router;
