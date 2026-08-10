import {Router,Response,NextFunction} from 'express';
import db from '../db';
import {requireAuth,AuthRequest} from '../middleware/auth';

const router=Router();
router.use(requireAuth);

const roles=(raw:any)=>{
  if(Array.isArray(raw))return raw.map(String).map(x=>x.toLowerCase());
  try{const p=JSON.parse(String(raw||''));if(Array.isArray(p))return p.map(String).map(x=>x.toLowerCase())}catch{}
  return String(raw||'').split(',').map(x=>x.replace(/[\[\]"]/g,'').trim().toLowerCase()).filter(Boolean)
};
const anyRole=(r:string[],xs:string[])=>r.some(x=>xs.includes(x));
const ADMIN=['admin','administrator','rendszergazda','superadmin','super_admin'];
const RECEPTION=['receptionist','recepciós','recepcios','reception'];
const BUSINESS_MANAGER=['location_manager','üzletvezető','uzletvezeto','store_manager','branch_manager'];
const SALON_MANAGER=['szalonvezető','szalonvezeto','salon_manager'];
const CUSTOMER=['customer','client','guest','ügyfél','ugyfel','vendég','vendeg'];
const STAFF=['employee','staff','munkatárs','munkatars','professional','specialist'];

type Scope={kind:'all'|'location'|'employee'|'customer'|'none';locationId:string|null;employeeId:string|null;customerId:string|null;canEdit:boolean;roleLabel:string};

async function relationExists(name:string){
  const q=await db.query(`SELECT to_regclass($1) IS NOT NULL ok`,[`public.${name}`]);
  return Boolean(q.rows[0]?.ok)
}

let workOrderItemsSchemaReady=false;
async function ensureWorkOrderItemsSchema(){
  if(workOrderItemsSchemaReady)return;
  await db.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  await db.query(`CREATE TABLE IF NOT EXISTS work_order_items(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),work_order_id uuid NOT NULL,item_type text,item_name text,
    service_id uuid,product_id uuid,quantity numeric(12,3) NOT NULL DEFAULT 1,unit_price numeric(14,2) NOT NULL DEFAULT 0,
    discount_amount numeric(14,2) NOT NULL DEFAULT 0,line_total numeric(14,2) NOT NULL DEFAULT 0,duration_minutes integer,
    created_at timestamptz NOT NULL DEFAULT now())`);
  for(const sql of [
    `ALTER TABLE work_order_items ADD COLUMN IF NOT EXISTS item_type text`,
    `ALTER TABLE work_order_items ADD COLUMN IF NOT EXISTS item_name text`,
    `ALTER TABLE work_order_items ADD COLUMN IF NOT EXISTS service_id uuid`,
    `ALTER TABLE work_order_items ADD COLUMN IF NOT EXISTS product_id uuid`,
    `ALTER TABLE work_order_items ADD COLUMN IF NOT EXISTS quantity numeric(12,3) NOT NULL DEFAULT 1`,
    `ALTER TABLE work_order_items ADD COLUMN IF NOT EXISTS unit_price numeric(14,2) NOT NULL DEFAULT 0`,
    `ALTER TABLE work_order_items ADD COLUMN IF NOT EXISTS discount_amount numeric(14,2) NOT NULL DEFAULT 0`,
    `ALTER TABLE work_order_items ADD COLUMN IF NOT EXISTS line_total numeric(14,2) NOT NULL DEFAULT 0`,
    `ALTER TABLE work_order_items ADD COLUMN IF NOT EXISTS duration_minutes integer`,
    `ALTER TABLE work_order_items ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`
  ])await db.query(sql);
  workOrderItemsSchemaReady=true
}

async function resolveScope(req:AuthRequest):Promise<Scope>{
  const r=roles(req.user?.role),uid=String(req.user?.id||''),email=String(req.user?.email||'').trim();
  if(anyRole(r,ADMIN))return{kind:'all',locationId:null,employeeId:null,customerId:null,canEdit:true,roleLabel:'admin'};
  const locationId=req.user?.location_id?String(req.user.location_id):null;
  if(anyRole(r,[...RECEPTION,...BUSINESS_MANAGER]))return{kind:'location',locationId,employeeId:null,customerId:null,canEdit:true,roleLabel:anyRole(r,RECEPTION)?'reception':'business_manager'};
  if(anyRole(r,SALON_MANAGER))return{kind:'location',locationId,employeeId:null,customerId:null,canEdit:false,roleLabel:'salon_manager'};
  if(anyRole(r,CUSTOMER)){
    let customerId:string|null=null;
    try{const q=await db.query(`SELECT id::text FROM clients WHERE ($1<>'' AND lower(COALESCE(email,''))=lower($1)) OR id::text=$2 ORDER BY CASE WHEN $1<>'' AND lower(COALESCE(email,''))=lower($1) THEN 0 ELSE 1 END LIMIT 1`,[email,uid]);customerId=q.rows[0]?.id||null}catch{}
    return{kind:'customer',locationId:null,employeeId:null,customerId,canEdit:false,roleLabel:'customer'}
  }
  let employeeId:string|null=null;let employeeLocation=locationId;
  try{
    const hasLoginName=(await db.query(`SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='employees' AND column_name='login_name') ok`)).rows[0]?.ok;
    const q=hasLoginName
      ?await db.query(`SELECT id::text,location_id::text FROM employees WHERE ($1<>'' AND (lower(COALESCE(email,''))=lower($1) OR lower(COALESCE(login_name,''))=lower($1))) OR id::text=$2 ORDER BY CASE WHEN $1<>'' AND lower(COALESCE(email,''))=lower($1) THEN 0 ELSE 1 END LIMIT 1`,[email,uid])
      :await db.query(`SELECT id::text,location_id::text FROM employees WHERE ($1<>'' AND lower(COALESCE(email,''))=lower($1)) OR id::text=$2 ORDER BY CASE WHEN $1<>'' AND lower(COALESCE(email,''))=lower($1) THEN 0 ELSE 1 END LIMIT 1`,[email,uid]);
    employeeId=q.rows[0]?.id||null;employeeLocation=q.rows[0]?.location_id||employeeLocation
  }catch{}
  if(anyRole(r,STAFF)||employeeId)return{kind:'employee',locationId:employeeLocation,employeeId,customerId:null,canEdit:false,roleLabel:'employee'};
  return{kind:'none',locationId:null,employeeId:null,customerId:null,canEdit:false,roleLabel:'none'}
}

function where(scope:Scope,alias='w'){
  switch(scope.kind){
    case'all':return{sql:'TRUE',params:[] as any[]};
    case'location':return scope.locationId?{sql:`${alias}.location_id=$1::uuid`,params:[scope.locationId]}:{sql:'FALSE',params:[] as any[]};
    case'employee':return scope.employeeId?{sql:`${alias}.employee_id=$1::uuid`,params:[scope.employeeId]}:{sql:'FALSE',params:[] as any[]};
    case'customer':return scope.customerId?{sql:`(${alias}.client_id=$1::uuid OR lower(COALESCE(${alias}.client_email,''))=lower(COALESCE((SELECT email FROM clients WHERE id=$1::uuid),'')))`,params:[scope.customerId]}:{sql:'FALSE',params:[] as any[]};
    default:return{sql:'FALSE',params:[] as any[]}
  }
}

async function requireVisible(req:AuthRequest,res:Response,next:NextFunction){
  try{
    const scope=await resolveScope(req),f=where(scope);
    const q=await db.query(`SELECT 1 FROM work_orders w WHERE w.id=$${f.params.length+1}::uuid AND ${f.sql} LIMIT 1`,[...f.params,req.params.id]);
    if(!q.rows[0])return res.status(404).json({message:'A munkalap nem található vagy nincs hozzá jogosultsága.'});
    (req as any).workOrderScope=scope;next()
  }catch(e:any){if(e?.code==='22P02')return res.status(400).json({message:'Érvénytelen munkalapazonosító.'});next(e)}
}

async function requireEditor(req:AuthRequest,res:Response,next:NextFunction){
  try{
    const scope=await resolveScope(req);
    if(!scope.canEdit)return res.status(403).json({message:'A munkalapot csak adminisztrátor, recepciós vagy üzletvezető módosíthatja.'});
    if(scope.kind==='location'&&!scope.locationId)return res.status(403).json({message:'A felhasználóhoz nincs szalon rendelve.'});
    (req as any).workOrderScope=scope;next()
  }catch(e){next(e)}
}

async function editableWorkOrder(id:string,scope:Scope){
  try{
    const q=await db.query(`SELECT id,work_order_number,location_id::text,employee_id::text,status,locked_at,archived_at,financial_closed_at FROM work_orders WHERE id=$1::uuid LIMIT 1`,[id]);
    const row=q.rows[0];
    if(!row)return{error:'not_found' as const,row:null};
    if(scope.kind==='location'&&String(row.location_id||'')!==String(scope.locationId||''))return{error:'not_found' as const,row:null};
    if(row.locked_at||row.archived_at)return{error:'locked' as const,row};
    return{error:null,row}
  }catch(e:any){
    if(e?.code==='42703'){
      const q=await db.query(`SELECT id,work_order_number,location_id::text,employee_id::text,status,NULL::timestamptz locked_at,NULL::timestamptz archived_at,NULL::timestamptz financial_closed_at FROM work_orders WHERE id=$1::uuid LIMIT 1`,[id]);
      const row=q.rows[0];if(!row)return{error:'not_found' as const,row:null};
      if(scope.kind==='location'&&String(row.location_id||'')!==String(scope.locationId||''))return{error:'not_found' as const,row:null};
      return{error:null,row}
    }
    throw e
  }
}

async function recalc(workOrderId:string){
  try{
    const exists=(await db.query(`SELECT to_regprocedure('recalc_work_order_totals(uuid)') IS NOT NULL ok`)).rows[0]?.ok;
    if(exists)await db.query(`SELECT recalc_work_order_totals($1::uuid)`,[workOrderId])
  }catch(e:any){
    console.warn('[workorders] total recalculation skipped:',e?.code||'',e?.message||e)
  }
}

router.get('/dashboard/summary',async(req:AuthRequest,res,next)=>{
  try{
    const scope=await resolveScope(req),f=where(scope);
    const hasItems=await relationExists('work_order_items');
    const valueSql=hasItems?`COALESCE(SUM((SELECT COALESCE(SUM(i.line_total),0) FROM work_order_items i WHERE i.work_order_id=w.id)) FILTER(WHERE w.status='completed'),0)::numeric`:`0::numeric`;
    const q=await db.query(`SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE w.status IN ('waiting','arrived','in_progress'))::int open,COUNT(*) FILTER(WHERE w.status='completed')::int completed,COUNT(*) FILTER(WHERE w.locked_at IS NOT NULL)::int archived,${valueSql} completed_value FROM work_orders w WHERE ${f.sql}`,f.params);
    const recent=await db.query(`SELECT w.id,w.work_order_number,w.title,w.status,w.created_at,w.locked_at,w.location_id,l.name location_name,w.client_name,e.full_name employee_name FROM work_orders w LEFT JOIN locations l ON l.id=w.location_id LEFT JOIN employees e ON e.id=w.employee_id WHERE ${f.sql} ORDER BY w.created_at DESC LIMIT 8`,f.params);
    res.json({scope:{kind:scope.kind,role:scope.roleLabel,can_edit:scope.canEdit,location_id:scope.locationId},stats:q.rows[0],recent:recent.rows})
  }catch(e:any){
    if(e?.code==='42703'){
      try{
        const scope=await resolveScope(req),f=where(scope);
        const q=await db.query(`SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE w.status IN ('waiting','arrived','in_progress'))::int open,COUNT(*) FILTER(WHERE w.status='completed')::int completed,0::int archived,0::numeric completed_value FROM work_orders w WHERE ${f.sql}`,f.params);
        const recent=await db.query(`SELECT w.id,w.work_order_number,w.title,w.status,w.created_at,w.location_id,l.name location_name,w.client_name,e.full_name employee_name FROM work_orders w LEFT JOIN locations l ON l.id=w.location_id LEFT JOIN employees e ON e.id=w.employee_id WHERE ${f.sql} ORDER BY w.created_at DESC LIMIT 8`,f.params);
        return res.json({scope:{kind:scope.kind,role:scope.roleLabel,can_edit:scope.canEdit,location_id:scope.locationId},stats:q.rows[0],recent:recent.rows})
      }catch(inner){return next(inner)}
    }
    next(e)
  }
});

router.get('/',async(req:AuthRequest,res,next)=>{
  try{
    const scope=await resolveScope(req),f=where(scope),hasView=await relationExists('v_work_orders_list');
    const params=[...f.params,scope.canEdit];
    const sql=hasView
      ?`SELECT v.*,w.work_order_number,w.locked_at,w.archived_at,w.archive_hash,w.location_id,l.name location_name,w.client_name,e.full_name employee_name,$${f.params.length+1}::boolean can_edit FROM v_work_orders_list v JOIN work_orders w ON w.id=v.id LEFT JOIN locations l ON l.id=w.location_id LEFT JOIN employees e ON e.id=w.employee_id WHERE ${f.sql} ORDER BY v.created_at DESC`
      :`SELECT w.*,l.name location_name,e.full_name employee_name,$${f.params.length+1}::boolean can_edit FROM work_orders w LEFT JOIN locations l ON l.id=w.location_id LEFT JOIN employees e ON e.id=w.employee_id WHERE ${f.sql} ORDER BY w.created_at DESC`;
    const result=await db.query(sql,params);res.json(result.rows)
  }catch(e){next(e)}
});

router.get('/:id/catalog',requireVisible,async(req:AuthRequest,res,next)=>{
  try{
    const wo=(await db.query(`SELECT location_id::text FROM work_orders WHERE id=$1::uuid`,[req.params.id])).rows[0];
    const locationId=String(wo?.location_id||'');
    const hasServiceTypes=await relationExists('service_types'),hasServiceLocations=await relationExists('service_locations');
    const serviceCategory=hasServiceTypes?`COALESCE((SELECT NULLIF(to_jsonb(st)->>'name','') FROM service_types st WHERE st.id::text=(to_jsonb(s)->>'service_type_id') LIMIT 1),'Egyéb')`:`'Egyéb'`;
    const locationFilter=hasServiceLocations?` AND ($1='' OR NOT EXISTS(SELECT 1 FROM service_locations sl0 WHERE sl0.service_id::text=s.id::text) OR EXISTS(SELECT 1 FROM service_locations sl WHERE sl.service_id::text=s.id::text AND sl.location_id::text=$1))`:``;
    const serviceSql=`SELECT s.id::text id,COALESCE(NULLIF(to_jsonb(s)->>'name',''),'Szolgáltatás') name,COALESCE(NULLIF(to_jsonb(s)->>'promo_price','')::numeric,NULLIF(to_jsonb(s)->>'list_price','')::numeric,NULLIF(to_jsonb(s)->>'base_price','')::numeric,NULLIF(to_jsonb(s)->>'price','')::numeric,0)::numeric price,COALESCE(NULLIF(to_jsonb(s)->>'duration_minutes','')::int,30)::int duration_minutes,${serviceCategory} category_name FROM services s WHERE COALESCE(NULLIF(to_jsonb(s)->>'is_active','')::boolean,true)=true${locationFilter} ORDER BY category_name,name`;
    const productSql=`SELECT p.id::text id,COALESCE(NULLIF(to_jsonb(p)->>'name',''),'Termék') name,COALESCE(NULLIF(to_jsonb(p)->>'sale_price','')::numeric,NULLIF(to_jsonb(p)->>'retail_price_gross','')::numeric,NULLIF(to_jsonb(p)->>'price','')::numeric,0)::numeric price,COALESCE(NULLIF(to_jsonb(p)->>'main_category',''),NULLIF(to_jsonb(p)->>'sub_category',''),NULLIF(to_jsonb(p)->>'category_name',''),'Termék') category_name FROM products p WHERE COALESCE(NULLIF(to_jsonb(p)->>'is_active','')::boolean,true)=true ORDER BY category_name,name`;
    const [services,products]=await Promise.all([db.query(serviceSql,hasServiceLocations?[locationId]:[]),db.query(productSql)]);
    res.json({services:services.rows,products:products.rows})
  }catch(e){next(e)}
});

router.get('/:id',requireVisible,async(req:AuthRequest,res,next)=>{
  try{
    const scope=(req as any).workOrderScope as Scope,hasView=await relationExists('v_work_order_details');
    const header=hasView
      ?await db.query(`SELECT v.*,w.work_order_number,w.source_created_at,w.source_snapshot,w.locked_at,w.locked_reason,w.archived_at,w.archive_hash,w.location_id,l.name location_name,w.client_id,w.client_name,w.client_phone,w.client_email,w.employee_id,e.full_name employee_name,w.fully_paid,w.note_for_another_visitor,w.payment_status,w.financial_closed_at,w.financial_closed_by,w.amount_due,w.amount_paid,w.discount_amount,w.tip_amount,w.invoice_status,$2::boolean can_edit FROM v_work_order_details v JOIN work_orders w ON w.id=v.id LEFT JOIN locations l ON l.id=w.location_id LEFT JOIN employees e ON e.id=w.employee_id WHERE v.id=$1::uuid`,[req.params.id,scope.canEdit])
      :await db.query(`SELECT w.*,l.name location_name,e.full_name employee_name,$2::boolean can_edit FROM work_orders w LEFT JOIN locations l ON l.id=w.location_id LEFT JOIN employees e ON e.id=w.employee_id WHERE w.id=$1::uuid`,[req.params.id,scope.canEdit]);
    if(!header.rows[0])return res.status(404).json({message:'A munkalap nem található.'});
    const items=await db.query(`SELECT id,item_type,service_id,product_id,item_name,quantity,unit_price,discount_amount,line_total,duration_minutes FROM work_order_items WHERE work_order_id=$1::uuid ORDER BY created_at`,[req.params.id]).catch(()=>({rows:[]} as any));
    const payments=await db.query(`SELECT id,payment_method,amount,paid_at,note FROM work_order_payments WHERE work_order_id=$1::uuid ORDER BY paid_at`,[req.params.id]).catch(()=>({rows:[]} as any));
    res.json({...header.rows[0],items:items.rows,payments:payments.rows})
  }catch(e){next(e)}
});

router.get('/:id/archive',requireVisible,async(req,res,next)=>{
  try{
    if(!(await relationExists('work_order_archive')))return res.status(404).json({message:'Ehhez a munkalaphoz még nincs lezárt archív példány.'});
    const q=await db.query(`SELECT id,work_order_id,work_order_number,archived_at,terminal_status,snapshot,snapshot_hash FROM work_order_archive WHERE work_order_id=$1::uuid`,[req.params.id]);
    if(!q.rows[0])return res.status(404).json({message:'Ehhez a munkalaphoz még nincs lezárt archív példány.'});res.json(q.rows[0])
  }catch(e){next(e)}
});

router.patch('/:id/lifecycle',requireEditor,async(req:AuthRequest,res,next)=>{
  try{
    const scope=(req as any).workOrderScope as Scope,check=await editableWorkOrder(req.params.id,scope);
    if(check.error==='not_found')return res.status(404).json({message:'Másik szalon munkalapja nem módosítható vagy a munkalap nem található.'});
    if(check.error==='locked')return res.status(409).json({message:`A(z) ${check.row?.work_order_number||'munkalap'} lezárt és archivált; nem módosítható.`});next()
  }catch(e:any){if(e?.code==='22P02')return res.status(400).json({message:'Érvénytelen munkalapazonosító.'});next(e)}
});

router.post('/:id/items',requireEditor,async(req:AuthRequest,res,next)=>{
  try{
    const scope=(req as any).workOrderScope as Scope,check=await editableWorkOrder(req.params.id,scope);
    if(check.error==='not_found')return res.status(404).json({message:'A munkalap nem található vagy másik szalonhoz tartozik.'});
    if(check.error==='locked')return res.status(409).json({message:'A lezárt munkalap tételei nem módosíthatók.'});
    if(check.row?.financial_closed_at)return res.status(409).json({message:'A pénzügyileg lezárt munkalap tételei már nem módosíthatók.'});
    await ensureWorkOrderItemsSchema();
    const kind=String(req.body?.item_type||'').toLowerCase(),itemId=String(req.body?.item_id||'').trim();
    const rawQuantity=Number(req.body?.quantity??1),rawDiscount=Number(req.body?.discount_amount??0);
    const quantity=Number.isFinite(rawQuantity)?Math.max(1,Math.min(99,rawQuantity)):1,discount=Number.isFinite(rawDiscount)?Math.max(0,rawDiscount):0;
    if(!['service','product'].includes(kind)||!itemId)return res.status(400).json({message:'Válasszon szolgáltatást vagy terméket.'});
    let row:any;
    if(kind==='service')row=(await db.query(`SELECT s.id,COALESCE(NULLIF(to_jsonb(s)->>'name',''),'Szolgáltatás') name,COALESCE(NULLIF(to_jsonb(s)->>'promo_price','')::numeric,NULLIF(to_jsonb(s)->>'list_price','')::numeric,NULLIF(to_jsonb(s)->>'base_price','')::numeric,NULLIF(to_jsonb(s)->>'price','')::numeric,0)::numeric price,COALESCE(NULLIF(to_jsonb(s)->>'duration_minutes','')::int,30)::int duration FROM services s WHERE s.id=$1::uuid AND COALESCE(NULLIF(to_jsonb(s)->>'is_active','')::boolean,true)=true`,[itemId])).rows[0];
    else row=(await db.query(`SELECT p.id,COALESCE(NULLIF(to_jsonb(p)->>'name',''),'Termék') name,COALESCE(NULLIF(to_jsonb(p)->>'sale_price','')::numeric,NULLIF(to_jsonb(p)->>'retail_price_gross','')::numeric,NULLIF(to_jsonb(p)->>'price','')::numeric,0)::numeric price FROM products p WHERE p.id=$1::uuid AND COALESCE(NULLIF(to_jsonb(p)->>'is_active','')::boolean,true)=true`,[itemId])).rows[0];
    if(!row)return res.status(404).json({message:'A kiválasztott tétel nem található vagy nem aktív.'});
    const unit=Number(row.price||0),line=Math.max(0,quantity*unit-discount);
    const q=kind==='service'
      ?await db.query(`INSERT INTO work_order_items(work_order_id,item_type,service_id,item_name,quantity,unit_price,discount_amount,line_total,duration_minutes) VALUES($1,'service',$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[req.params.id,row.id,row.name,quantity,unit,discount,line,row.duration])
      :await db.query(`INSERT INTO work_order_items(work_order_id,item_type,product_id,item_name,quantity,unit_price,discount_amount,line_total) VALUES($1,'product',$2,$3,$4,$5,$6,$7) RETURNING *`,[req.params.id,row.id,row.name,quantity,unit,discount,line]);
    await recalc(req.params.id);res.status(201).json(q.rows[0])
  }catch(e:any){
    if(e?.code==='22P02')return res.status(400).json({message:'Érvénytelen tételazonosító.'});
    console.error('[workorders] item insert failed',e?.code||'',e?.message||e);next(e)
  }
});

router.delete('/:id/items/:itemId',requireEditor,async(req:AuthRequest,res,next)=>{
  try{
    const scope=(req as any).workOrderScope as Scope,check=await editableWorkOrder(req.params.id,scope);
    if(check.error==='not_found')return res.status(404).json({message:'A munkalap nem található vagy másik szalonhoz tartozik.'});
    if(check.error==='locked')return res.status(409).json({message:'A lezárt munkalap tételei nem módosíthatók.'});
    if(check.row?.financial_closed_at)return res.status(409).json({message:'A pénzügyileg lezárt munkalap tételei már nem módosíthatók.'});
    await ensureWorkOrderItemsSchema();
    const q=await db.query(`DELETE FROM work_order_items WHERE id=$1::uuid AND work_order_id=$2::uuid RETURNING id`,[req.params.itemId,req.params.id]);
    if(!q.rows[0])return res.status(404).json({message:'A munkalaptétel nem található.'});await recalc(req.params.id);res.json({ok:true})
  }catch(e:any){if(e?.code==='22P02')return res.status(400).json({message:'Érvénytelen tételazonosító.'});next(e)}
});

router.patch('/:id',requireEditor,async(req:AuthRequest,res,next)=>{
  try{
    const scope=(req as any).workOrderScope as Scope,check=await editableWorkOrder(req.params.id,scope);
    if(check.error==='not_found')return res.status(404).json({message:'Másik szalon munkalapja nem módosítható vagy a munkalap nem található.'});
    if(check.error==='locked')return res.status(409).json({message:`A(z) ${check.row?.work_order_number||'munkalap'} lezárt és archivált; nem módosítható.`});
    const b=req.body||{};
    if(Object.prototype.hasOwnProperty.call(b,'title')&&!String(b.title||'').trim())return res.status(400).json({message:'A munkalap címe nem lehet üres.'});
    if(Object.prototype.hasOwnProperty.call(b,'employee_id')&&b.employee_id){
      const employee=await db.query(`SELECT id,location_id::text FROM employees WHERE id=$1::uuid AND COALESCE(active,true)=true LIMIT 1`,[b.employee_id]);
      if(!employee.rows[0])return res.status(400).json({message:'A kiválasztott munkatárs nem található vagy nem aktív.'});
      const workLocation=String(check.row?.location_id||''),employeeLocation=String(employee.rows[0].location_id||'');
      if(workLocation&&workLocation!==employeeLocation)return res.status(400).json({message:'A munkatárs nem ehhez a szalonhoz tartozik.'})
    }
    const sets:string[]=[];const params:any[]=[req.params.id];
    const add=(key:string,column:string,value:any,cast='')=>{if(!Object.prototype.hasOwnProperty.call(b,key))return;params.push(value);sets.push(`${column}=$${params.length}${cast}`)};
    add('title','title',String(b.title||'').trim());add('notes','notes',b.notes===null?null:String(b.notes||''));add('employee_id','employee_id',b.employee_id||null,'::uuid');add('client_id','client_id',b.client_id||null,'::uuid');add('client_name','client_name',b.client_name===null?null:String(b.client_name||''));add('client_phone','client_phone',b.client_phone===null?null:String(b.client_phone||''));add('client_email','client_email',b.client_email===null?null:String(b.client_email||''));add('note_for_another_visitor','note_for_another_visitor',Boolean(b.note_for_another_visitor));
    if(!sets.length)return res.status(400).json({message:'Nincs módosítható mező a kérésben.'});
    const q=await db.query(`UPDATE work_orders SET ${sets.join(',')},updated_at=now() WHERE id=$1::uuid RETURNING *`,params);res.json(q.rows[0])
  }catch(e:any){if(e?.code==='22P02')return res.status(400).json({message:'Érvénytelen azonosító a munkalap módosításában.'});next(e)}
});

router.post('/',requireEditor,(req:AuthRequest,res,next)=>{
  const scope=(req as any).workOrderScope as Scope;
  if(scope.kind==='location'){
    if(req.body?.location_id&&String(req.body.location_id)!==String(scope.locationId))return res.status(403).json({message:'Csak a saját szalonhoz hozhat létre munkalapot.'});
    req.body={...(req.body||{}),location_id:scope.locationId}
  }
  next()
});

export default router;