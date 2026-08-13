import {Router} from 'express';
import db from '../db';
import {requireAuth,AuthRequest} from '../middleware/auth';

const router=Router();
router.use(requireAuth);
const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actor=(req:AuthRequest)=>req.user?.email||String(req.user?.id||'');
const roles=(req:AuthRequest)=>{const raw:any=req.user?.role;if(Array.isArray(raw))return raw.map(String).map(x=>x.toLowerCase());try{const a=JSON.parse(String(raw||''));if(Array.isArray(a))return a.map(String).map(x=>x.toLowerCase())}catch{}return String(raw||'').split(',').map(x=>x.replace(/[\[\]"]/g,'').trim().toLowerCase()).filter(Boolean)};
const ADMINS=new Set(['admin','administrator','rendszergazda','superadmin','super_admin']);
const MANAGERS=new Set([...ADMINS,'location_manager','salon_manager','szalonvezető','szalonvezeto','üzletvezető','uzletvezeto','store_manager','branch_manager']);
const EDITORS=new Set([...MANAGERS,'receptionist','reception','recepciós','recepcios']);
const requireEditor=(req:AuthRequest,res:any,next:any)=>roles(req).some(r=>EDITORS.has(r))?next():res.status(403).json({message:'Az ügyfél foglalási tiltását csak recepciós vagy vezető módosíthatja.'});
const requireManager=(req:AuthRequest,res:any,next:any)=>roles(req).some(r=>MANAGERS.has(r))?next():res.status(403).json({message:'Ügyfél-összevonást csak adminisztrátor vagy vezető végezhet.'});
const qi=(s:string)=>`"${String(s).replace(/"/g,'""')}"`;

async function ensureSchema(cx:any=db){
 await cx.query(`
  ALTER TABLE clients ADD COLUMN IF NOT EXISTS merged_into_client_id uuid;
  ALTER TABLE clients ADD COLUMN IF NOT EXISTS merged_at timestamptz;
  ALTER TABLE clients ADD COLUMN IF NOT EXISTS merged_by text;
  ALTER TABLE clients ADD COLUMN IF NOT EXISTS merge_note text;
  CREATE INDEX IF NOT EXISTS clients_merged_into_idx ON clients(merged_into_client_id) WHERE merged_into_client_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS client_booking_controls(
    client_id uuid PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
    online_booking_blocked boolean NOT NULL DEFAULT false,
    block_reason text,
    updated_by text,
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS client_merge_audit(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_client_id uuid NOT NULL,
    target_client_id uuid NOT NULL,
    source_snapshot jsonb NOT NULL,
    target_before_snapshot jsonb NOT NULL,
    target_after_snapshot jsonb NOT NULL,
    moved_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
    conflicts jsonb NOT NULL DEFAULT '[]'::jsonb,
    note text,
    merged_by text NOT NULL,
    merged_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS client_merge_audit_source_idx ON client_merge_audit(source_client_id,merged_at DESC);
  CREATE INDEX IF NOT EXISTS client_merge_audit_target_idx ON client_merge_audit(target_client_id,merged_at DESC);
 `);
}
router.use(async(_req,_res,next)=>{try{await ensureSchema();next()}catch(e){next(e)}});

function canAccess(req:AuthRequest,client:any){const rs=roles(req);if(rs.some(r=>ADMINS.has(r)))return true;const loc=String(req.user?.location_id||'');return Boolean(loc&&String(client?.location_id||'')===loc)}
async function clientsPair(cx:any,sourceId:string,targetId:string){const {rows}=await cx.query(`SELECT id::text,location_id::text,full_name,name,email,phone,is_active,merged_into_client_id::text,to_jsonb(clients.*) snapshot FROM clients WHERE id=ANY($1::uuid[]) FOR UPDATE`,[[sourceId,targetId]]);return{source:rows.find((x:any)=>x.id===sourceId),target:rows.find((x:any)=>x.id===targetId)}}
async function existsTable(cx:any,table:string){return Boolean((await cx.query(`SELECT to_regclass($1) IS NOT NULL ok`,[`public.${table}`])).rows[0]?.ok)}
async function existsColumn(cx:any,table:string,column:string){return Boolean((await cx.query(`SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2) ok`,[table,column])).rows[0]?.ok)}

async function mergeLoyalty(cx:any,sourceId:string,targetId:string,moved:any){
 if(await existsTable(cx,'loyalty_accounts')){
  const accounts=(await cx.query(`SELECT * FROM loyalty_accounts WHERE customer_id=ANY($1::text[]) FOR UPDATE`,[[sourceId,targetId]])).rows,source=accounts.find((x:any)=>x.customer_id===sourceId),target=accounts.find((x:any)=>x.customer_id===targetId);
  if(source&&target){
   const refs=(await cx.query(`SELECT ns.nspname schema_name,cl.relname table_name,a.attname column_name FROM pg_constraint c JOIN pg_class cl ON cl.oid=c.conrelid JOIN pg_namespace ns ON ns.oid=cl.relnamespace JOIN unnest(c.conkey) WITH ORDINALITY ck(attnum,ord) ON true JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ck.attnum WHERE c.contype='f' AND c.confrelid='loyalty_accounts'::regclass AND ns.nspname='public' AND array_length(c.conkey,1)=1`)).rows;
   for(const ref of refs){try{const r=await cx.query(`UPDATE ${qi(ref.schema_name)}.${qi(ref.table_name)} SET ${qi(ref.column_name)}=$1::uuid WHERE ${qi(ref.column_name)}=$2::uuid`,[target.id,source.id]);if(r.rowCount)moved[`loyalty:${ref.table_name}.${ref.column_name}`]=(moved[`loyalty:${ref.table_name}.${ref.column_name}`]||0)+r.rowCount}catch(e:any){if(e?.code==='23505')throw Object.assign(new Error(`A hűségadatok összevonása egyedi ütközést okoz: ${ref.table_name}.`),{status:409,mergeConflict:ref.table_name});throw e}}
   await cx.query(`UPDATE loyalty_accounts SET balance=balance+$2,points=points+$3,card_identifier=COALESCE(card_identifier,$4),external_identifier=COALESCE(external_identifier,$5),updated_at=now() WHERE id=$1::uuid`,[target.id,Number(source.balance||0),Number(source.points||0),source.card_identifier||null,source.external_identifier||null]);
   await cx.query(`DELETE FROM loyalty_accounts WHERE id=$1::uuid`,[source.id]);moved.loyalty_accounts=1;
  }else if(source){await cx.query(`UPDATE loyalty_accounts SET customer_id=$2,updated_at=now() WHERE id=$1::uuid`,[source.id,targetId]);moved.loyalty_accounts=1}
 }
 for(const [table,column] of [['loyalty_coupons','customer_id'],['loyalty_vouchers','purchaser_customer_id'],['loyalty_vouchers','owner_customer_id'],['loyalty_sales','customer_id']] as const){if(await existsTable(cx,table)&&await existsColumn(cx,table,column)){const r=await cx.query(`UPDATE ${qi(table)} SET ${qi(column)}=$1 WHERE ${qi(column)}=$2`,[targetId,sourceId]);if(r.rowCount)moved[`${table}.${column}`]=(moved[`${table}.${column}`]||0)+r.rowCount}}
}

async function foreignKeyImpact(cx:any,sourceId:string,targetId:string){
 const refs=(await cx.query(`SELECT ns.nspname schema_name,cl.relname table_name,a.attname column_name FROM pg_constraint c JOIN pg_class cl ON cl.oid=c.conrelid JOIN pg_namespace ns ON ns.oid=cl.relnamespace JOIN unnest(c.conkey) WITH ORDINALITY ck(attnum,ord) ON true JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ck.attnum WHERE c.contype='f' AND c.confrelid='clients'::regclass AND ns.nspname='public' AND array_length(c.conkey,1)=1 ORDER BY cl.relname,a.attname`)).rows;
 const impact=[];for(const ref of refs){const counts=(await cx.query(`SELECT count(*) FILTER(WHERE ${qi(ref.column_name)}=$1::uuid)::int source_count,count(*) FILTER(WHERE ${qi(ref.column_name)}=$2::uuid)::int target_count FROM ${qi(ref.schema_name)}.${qi(ref.table_name)}`,[sourceId,targetId])).rows[0];impact.push({...ref,source_count:Number(counts.source_count||0),target_count:Number(counts.target_count||0))}return impact;
}

router.get('/:id/governance',async(req:AuthRequest,res,next)=>{try{if(!UUID_RE.test(req.params.id))return res.status(400).json({message:'Érvénytelen ügyfélazonosító.'});const client=(await db.query(`SELECT id::text,location_id::text,full_name,name,email,phone,is_active,merged_into_client_id::text,merged_at,merged_by,merge_note FROM clients WHERE id=$1::uuid`,[req.params.id])).rows[0];if(!client)return res.status(404).json({message:'Az ügyfél nem található.'});if(!canAccess(req,client))return res.status(403).json({message:'Ehhez az ügyfélhez nincs hozzáférése.'});const control=(await db.query(`SELECT * FROM client_booking_controls WHERE client_id=$1::uuid`,[req.params.id])).rows[0]||{online_booking_blocked:false};const audits=(await db.query(`SELECT id::text,source_client_id::text,target_client_id::text,moved_counts,note,merged_by,merged_at FROM client_merge_audit WHERE source_client_id=$1::uuid OR target_client_id=$1::uuid ORDER BY merged_at DESC LIMIT 25`,[req.params.id])).rows;res.json({client,booking_control:control,merge_history:audits})}catch(e){next(e)}});

router.patch('/:id/online-booking-block',requireEditor,async(req:AuthRequest,res,next)=>{try{if(!UUID_RE.test(req.params.id))return res.status(400).json({message:'Érvénytelen ügyfélazonosító.'});const client=(await db.query(`SELECT id::text,location_id::text,merged_into_client_id::text FROM clients WHERE id=$1::uuid`,[req.params.id])).rows[0];if(!client)return res.status(404).json({message:'Az ügyfél nem található.'});if(!canAccess(req,client))return res.status(403).json({message:'Ehhez az ügyfélhez nincs hozzáférése.'});if(client.merged_into_client_id)return res.status(409).json({message:'Ez az ügyfél már össze lett vonva. A cél ügyfél beállítását módosítsa.',merged_into_client_id:client.merged_into_client_id});const blocked=Boolean(req.body?.blocked),reason=String(req.body?.reason||'').trim();if(blocked&&reason.length<3)return res.status(400).json({message:'A tiltás indoka kötelező.'});const {rows}=await db.query(`INSERT INTO client_booking_controls(client_id,online_booking_blocked,block_reason,updated_by,updated_at) VALUES($1::uuid,$2,$3,$4,now()) ON CONFLICT(client_id) DO UPDATE SET online_booking_blocked=EXCLUDED.online_booking_blocked,block_reason=EXCLUDED.block_reason,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,[req.params.id,blocked,blocked?reason:null,actor(req)]);res.json(rows[0])}catch(e){next(e)}});

router.post('/duplicates/merge-preview',requireManager,async(req:AuthRequest,res,next)=>{const cx=await db.connect();try{const sourceId=String(req.body?.source_client_id||''),targetId=String(req.body?.target_client_id||'');if(!UUID_RE.test(sourceId)||!UUID_RE.test(targetId)||sourceId===targetId)return res.status(400).json({message:'Két külön, érvényes ügyfélazonosító szükséges.'});await cx.query('BEGIN');const pair=await clientsPair(cx,sourceId,targetId);if(!pair.source||!pair.target){await cx.query('ROLLBACK');return res.status(404).json({message:'Az egyik ügyfél nem található.'})}if(!canAccess(req,pair.source)||!canAccess(req,pair.target)){await cx.query('ROLLBACK');return res.status(403).json({message:'Az egyik ügyfélhez nincs hozzáférése.'})}if(String(pair.source.location_id||'')!==String(pair.target.location_id||'')){await cx.query('ROLLBACK');return res.status(409).json({message:'Automatikus összevonás csak azonos telephelyű ügyfelek között engedélyezett.'})}const impact=await foreignKeyImpact(cx,sourceId,targetId);const textImpact:any[]=[];for(const [table,column] of [['loyalty_accounts','customer_id'],['loyalty_coupons','customer_id'],['loyalty_vouchers','purchaser_customer_id'],['loyalty_vouchers','owner_customer_id'],['loyalty_sales','customer_id']] as const)if(await existsTable(cx,table)&&await existsColumn(cx,table,column)){const r=(await cx.query(`SELECT count(*)::int n FROM ${qi(table)} WHERE ${qi(column)}=$1`,[sourceId])).rows[0];if(Number(r.n))textImpact.push({table_name:table,column_name:column,source_count:Number(r.n)})}await cx.query('ROLLBACK');res.json({source:pair.source,target:pair.target,foreign_keys:impact.filter((x:any)=>x.source_count>0),text_references:textImpact})}catch(e){await cx.query('ROLLBACK').catch(()=>undefined);next(e)}finally{cx.release()}});

router.post('/duplicates/merge',requireManager,async(req:AuthRequest,res,next)=>{const cx=await db.connect();try{
 const sourceId=String(req.body?.source_client_id||''),targetId=String(req.body?.target_client_id||''),note=String(req.body?.note||'').trim();if(!UUID_RE.test(sourceId)||!UUID_RE.test(targetId)||sourceId===targetId)return res.status(400).json({message:'Két külön, érvényes ügyfélazonosító szükséges.'});await cx.query('BEGIN');await ensureSchema(cx);const pair=await clientsPair(cx,sourceId,targetId);if(!pair.source||!pair.target){await cx.query('ROLLBACK');return res.status(404).json({message:'Az egyik ügyfél nem található.'})}if(pair.source.merged_into_client_id){await cx.query('ROLLBACK');return res.status(409).json({message:'A forrás ügyfél már össze lett vonva.',merged_into_client_id:pair.source.merged_into_client_id})}if(pair.target.merged_into_client_id){await cx.query('ROLLBACK');return res.status(409).json({message:'A cél ügyfél maga is egy összevont forrás. Válassza a végleges cél ügyfelet.',merged_into_client_id:pair.target.merged_into_client_id})}if(!canAccess(req,pair.source)||!canAccess(req,pair.target)){await cx.query('ROLLBACK');return res.status(403).json({message:'Az egyik ügyfélhez nincs hozzáférése.'})}if(String(pair.source.location_id||'')!==String(pair.target.location_id||'')){await cx.query('ROLLBACK');return res.status(409).json({message:'Automatikus összevonás csak azonos telephelyű ügyfelek között engedélyezett.'})}
 const moved:any={};
 if(await existsTable(cx,'crm_client_tags')){const ins=await cx.query(`INSERT INTO crm_client_tags(client_id,tag_id,created_at) SELECT $1::uuid,tag_id,created_at FROM crm_client_tags WHERE client_id=$2::uuid ON CONFLICT(client_id,tag_id) DO NOTHING`,[targetId,sourceId]);await cx.query(`DELETE FROM crm_client_tags WHERE client_id=$1::uuid`,[sourceId]);if(ins.rowCount)moved.crm_client_tags=ins.rowCount}
 const refs=await foreignKeyImpact(cx,sourceId,targetId);for(const ref of refs){if(!ref.source_count||ref.table_name==='crm_client_tags'||ref.table_name==='client_booking_controls')continue;const savepoint=`sp_${Math.random().toString(36).slice(2,10)}`;await cx.query(`SAVEPOINT ${savepoint}`);try{const r=await cx.query(`UPDATE ${qi(ref.schema_name)}.${qi(ref.table_name)} SET ${qi(ref.column_name)}=$1::uuid WHERE ${qi(ref.column_name)}=$2::uuid`,[targetId,sourceId]);if(r.rowCount)moved[`${ref.table_name}.${ref.column_name}`]=r.rowCount;await cx.query(`RELEASE SAVEPOINT ${savepoint}`)}catch(e:any){await cx.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);if(e?.code==='23505'){await cx.query('ROLLBACK');return res.status(409).json({message:`Az összevonás egyedi rekordütközés miatt nem automatikus a(z) ${ref.table_name} táblában.`,conflict_table:ref.table_name,conflict_column:ref.column_name})}throw e}}
 await mergeLoyalty(cx,sourceId,targetId,moved);
 const controls=(await cx.query(`SELECT * FROM client_booking_controls WHERE client_id=ANY($1::uuid[])`,[[sourceId,targetId]])).rows,sourceControl=controls.find((x:any)=>String(x.client_id)===sourceId),targetControl=controls.find((x:any)=>String(x.client_id)===targetId);if(sourceControl?.online_booking_blocked||targetControl?.online_booking_blocked)await cx.query(`INSERT INTO client_booking_controls(client_id,online_booking_blocked,block_reason,updated_by) VALUES($1::uuid,true,$2,$3) ON CONFLICT(client_id) DO UPDATE SET online_booking_blocked=true,block_reason=COALESCE(client_booking_controls.block_reason,EXCLUDED.block_reason),updated_by=EXCLUDED.updated_by,updated_at=now()`,[targetId,targetControl?.block_reason||sourceControl?.block_reason||'Összevont ügyfél tiltása',actor(req)]);
 const targetAfter=(await cx.query(`UPDATE clients t SET full_name=COALESCE(NULLIF(t.full_name,''),NULLIF(s.full_name,'')),name=COALESCE(NULLIF(t.name,''),NULLIF(s.name,'')),phone=COALESCE(NULLIF(t.phone,''),NULLIF(s.phone,'')),email=COALESCE(NULLIF(t.email,''),NULLIF(s.email,'')),marketing_consent=COALESCE(t.marketing_consent,false) OR COALESCE(s.marketing_consent,false),updated_at=now() FROM clients s WHERE t.id=$1::uuid AND s.id=$2::uuid RETURNING to_jsonb(t.*) snapshot`,[targetId,sourceId])).rows[0]?.snapshot;
 await cx.query(`UPDATE clients SET is_active=false,merged_into_client_id=$2::uuid,merged_at=now(),merged_by=$3,merge_note=$4,updated_at=now() WHERE id=$1::uuid`,[sourceId,targetId,actor(req),note||null]);
 const audit=(await cx.query(`INSERT INTO client_merge_audit(source_client_id,target_client_id,source_snapshot,target_before_snapshot,target_after_snapshot,moved_counts,note,merged_by) VALUES($1::uuid,$2::uuid,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8) RETURNING id::text,merged_at`,[sourceId,targetId,JSON.stringify(pair.source.snapshot),JSON.stringify(pair.target.snapshot),JSON.stringify(targetAfter),JSON.stringify(moved),note||null,actor(req)])).rows[0];await cx.query('COMMIT');res.status(201).json({ok:true,source_client_id:sourceId,target_client_id:targetId,moved_counts:moved,audit_id:audit.id,merged_at:audit.merged_at});
 }catch(e:any){await cx.query('ROLLBACK').catch(()=>undefined);if(e?.status)return res.status(e.status).json({message:e.message,conflict_table:e.mergeConflict||null});next(e)}finally{cx.release()}});

export default router;
