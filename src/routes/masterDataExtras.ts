import { Router } from "express";
import db from "../db";
import type { AuthRequest } from "../middleware/auth";

const router = Router();
let ready: Promise<void> | null = null;

const definitions = [
  {
    key: "discounts",
    title: "Kedvezménytörzs",
    singular: "kedvezmény",
    description: "A vendégadatlapon és munkalapon választható kedvezmények. Százalékos vagy fix összegű, szolgáltatásra és termékre külön értékkel, időszak- és idősáv-megadással.",
    activeColumn: "active",
    route: "/masterdata?entity=discounts",
    fields: [
      { key: "code", label: "Kód", type: "text", required: true },
      { key: "name", label: "Név", type: "text", required: true },
      { key: "discount_type", label: "Típus", type: "select", required: true, options: [{value:"percent",label:"Százalék"},{value:"fixed",label:"Fix összeg (Ft)"}] },
      { key: "service_value", label: "Szolgáltatás kedvezménye", type: "number" },
      { key: "product_value", label: "Termék / eszköz kedvezménye", type: "number" },
      { key: "service_category", label: "Szolgáltatás kategória", type: "text" },
      { key: "product_type", label: "Terméktípus", type: "text" },
      { key: "valid_from", label: "Érvényesség kezdete", type: "date" },
      { key: "valid_until", label: "Érvényesség vége", type: "date" },
      { key: "weekdays", label: "Napok (1=hétfő … 7=vasárnap)", type: "text", placeholder: "pl. 1,2,3,4,5" },
      { key: "time_from", label: "Idősáv kezdete", type: "text", placeholder: "09:00" },
      { key: "time_to", label: "Idősáv vége", type: "text", placeholder: "17:30" },
      { key: "sort_order", label: "Sorrend", type: "number" },
      { key: "active", label: "Aktív", type: "boolean" },
    ],
    listFields: ["code","name","discount_type","service_value","product_value","valid_from","valid_until","active"],
  },
  {
    key: "guest-account-transaction-types",
    title: "Vendégszámla-tranzakciótípusok",
    singular: "vendégszámla-tranzakciótípus",
    description: "A vendégszámla műveleteknél választható típustörzs, a kapcsolódó pénzügyi tranzakciótípussal.",
    activeColumn: "active",
    route: "/masterdata?entity=guest-account-transaction-types",
    fields: [
      { key: "code", label: "Kód", type: "text", required: true },
      { key: "name", label: "Név", type: "text", required: true },
      { key: "financial_transaction_type_id", label: "Pénzügyi tranzakciótípus", type: "relation", relationEntity: "financial-transaction-types", required: true },
      { key: "sort_order", label: "Sorrend", type: "number" },
      { key: "active", label: "Aktív", type: "boolean" },
    ],
    listFields: ["code","name","financial_transaction_type_id","active"],
  },
] as const;

const byKey = new Map(definitions.map(x => [x.key, x]));
const tableOf: Record<string,string> = { discounts:"master_discounts", "guest-account-transaction-types":"guest_account_transaction_types" };
const orderOf: Record<string,string> = { discounts:"sort_order,name", "guest-account-transaction-types":"sort_order,name" };
const searchOf: Record<string,string[]> = { discounts:["code","name","service_category","product_type"], "guest-account-transaction-types":["code","name"] };

function actor(req: AuthRequest) { return req.user?.email || String(req.user?.id || ""); }
function safe(value:string){ if(!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error("Érvénytelen SQL azonosító."); return value; }
function value(field:any, raw:any){ if(raw===undefined)return undefined;if(raw===null||raw==="")return field.type==="boolean"?false:null;if(field.type==="number"){const n=Number(raw);if(!Number.isFinite(n))throw Object.assign(new Error(`${field.label}: érvénytelen szám.`),{status:400});return n;}if(field.type==="boolean")return Boolean(raw);return String(raw).trim(); }
async function audit(req:AuthRequest,key:string,id:string,action:string,before:any,after:any){await db.query(`INSERT INTO master_data_audit(entity_key,record_id,action,actor,before_data,after_data) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,[key,id,action,actor(req),JSON.stringify(before??null),JSON.stringify(after??null)]);}

async function ensureSchema(){
 if(ready)return ready;
 ready=(async()=>{await db.query(`
  CREATE TABLE IF NOT EXISTS master_discounts(
    id bigserial PRIMARY KEY,code text NOT NULL UNIQUE,name text NOT NULL,
    discount_type text NOT NULL DEFAULT 'percent' CHECK(discount_type IN('percent','fixed')),
    service_value numeric(12,2) NOT NULL DEFAULT 0,product_value numeric(12,2) NOT NULL DEFAULT 0,
    service_category text,product_type text,valid_from date,valid_until date,weekdays text,time_from text,time_to text,
    sort_order integer NOT NULL DEFAULT 100,active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK(valid_until IS NULL OR valid_from IS NULL OR valid_until>=valid_from)
  );
  CREATE TABLE IF NOT EXISTS guest_account_transaction_types(
    id bigserial PRIMARY KEY,code text NOT NULL UNIQUE,name text NOT NULL,
    financial_transaction_type_id bigint REFERENCES finance_document_types(id),
    sort_order integer NOT NULL DEFAULT 100,active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
  );
  DO $$ BEGIN
   IF to_regclass('public.menus') IS NOT NULL THEN
    INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
    SELECT v.code,v.name,NULL,v.route,v.order_index,m.id,v.feature_key,true
    FROM (VALUES
      ('masterdata.user-groups','Felhasználói csoportok','/admin/access-control',15,'access_control'),
      ('masterdata.users','Felhasználók','/employees',20,'hr'),
      ('masterdata.discounts','Kedvezménytörzs','/masterdata?entity=discounts',65,'master_data'),
      ('masterdata.warehouses','Raktárak','/masterdata/warehouses',110,'warehouses'),
      ('masterdata.guest-account-transaction-types','Vendégszámla-tranzakciótípusok','/masterdata?entity=guest-account-transaction-types',135,'finance')
    ) AS v(code,name,route,order_index,feature_key)
    CROSS JOIN (SELECT id FROM menus WHERE code='masterdata' LIMIT 1) m
    ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,route=EXCLUDED.route,order_index=EXCLUDED.order_index,parent_id=EXCLUDED.parent_id,feature_key=EXCLUDED.feature_key,is_active=true;

    INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at)
    SELECT r.role_key,m.id,true,true,true,false,false,true,true,(r.role_key='admin'),'all_locations',now()
    FROM (VALUES('admin'),('manager')) r(role_key)
    JOIN menus m ON m.code='masterdata' OR m.code LIKE 'masterdata.%'
    ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=true,can_create=true,can_edit=true,can_export=true,can_view_financial=true,scope_type='all_locations',updated_at=now();
   END IF;
  END $$;
 `);})().catch(e=>{ready=null;throw e});
 return ready;
}

router.use(async(_req,_res,next)=>{try{await ensureSchema();next()}catch(e){next(e)}});

router.get('/extras/catalog',async(_req,res,next)=>{try{const counts:Record<string,number>={};for(const def of definitions){const table=safe(tableOf[def.key]);counts[def.key]=Number((await db.query(`SELECT count(*)::int count FROM ${table} WHERE active=true`)).rows[0]?.count||0);}res.json({entities:definitions,counts});}catch(e){next(e)}});

router.get('/:entity/export.csv',async(req,res,next)=>{const def=byKey.get(req.params.entity as any);if(!def)return next();try{const rows=(await db.query(`SELECT * FROM ${safe(tableOf[def.key])} ORDER BY ${orderOf[def.key]}`)).rows;const map=new Map((def.fields as readonly any[]).map((f:any)=>[f.key,f]));const cols=[...def.listFields];const esc=(v:any)=>`"${String(v??'').replace(/"/g,'""')}"`;const csv=[cols.map(k=>esc((map.get(k) as any)?.label||k)).join(';'),...rows.map(r=>cols.map(k=>esc(r[k])).join(';'))].join('\r\n');res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="${def.key}.csv"`);res.send(`\uFEFF${csv}`);}catch(e){next(e)}});

router.get('/:entity',async(req,res,next)=>{const def=byKey.get(req.params.entity as any);if(!def)return next();try{const include=String(req.query.include_inactive||'')==='1',q=String(req.query.q||'').trim();const cols=searchOf[def.key];const search=cols.length?`AND ($2='' OR ${cols.map(c=>`COALESCE(${safe(c)}::text,'') ILIKE '%'||$2||'%'`).join(' OR ')})`:'';const rows=(await db.query(`SELECT * FROM ${safe(tableOf[def.key])} WHERE ($1::boolean OR active=true) ${search} ORDER BY ${orderOf[def.key]} LIMIT 1000`,[include,q])).rows;res.json(rows);}catch(e){next(e)}});

router.post('/:entity',async(req:AuthRequest,res,next)=>{const def=byKey.get(req.params.entity as any);if(!def)return next();try{const cols:string[]=[],vals:any[]=[];for(const field of def.fields as readonly any[]){const raw=req.body?.[field.key];if(field.required&&(raw===undefined||raw===null||String(raw).trim()===''))return res.status(400).json({message:`${field.label}: kötelező mező.`});if(raw!==undefined){cols.push(safe(field.key));vals.push(value(field,raw));}}if(!cols.length)return res.status(400).json({message:'Nincs menthető mező.'});const row=(await db.query(`INSERT INTO ${safe(tableOf[def.key])}(${cols.join(',')}) VALUES(${vals.map((_,i)=>`$${i+1}`).join(',')}) RETURNING *`,vals)).rows[0];await audit(req,def.key,String(row.id),'create',null,row);res.status(201).json(row);}catch(e:any){if(e?.code==='23505')return res.status(409).json({message:'Ezzel a kóddal már létezik rekord.'});next(e)}});

router.patch('/:entity/:id',async(req:AuthRequest,res,next)=>{const def=byKey.get(req.params.entity as any);if(!def)return next();try{const table=safe(tableOf[def.key]);const before=(await db.query(`SELECT * FROM ${table} WHERE id::text=$1 LIMIT 1`,[req.params.id])).rows[0];if(!before)return res.status(404).json({message:'A törzsadat nem található.'});const sets:string[]=[],vals:any[]=[];for(const field of def.fields as readonly any[]){if(req.body?.[field.key]===undefined)continue;vals.push(value(field,req.body[field.key]));sets.push(`${safe(field.key)}=$${vals.length}`);}if(!sets.length)return res.status(400).json({message:'Nincs módosítandó mező.'});vals.push(req.params.id);const row=(await db.query(`UPDATE ${table} SET ${sets.join(',')},updated_at=now() WHERE id::text=$${vals.length} RETURNING *`,vals)).rows[0];await audit(req,def.key,req.params.id,'update',before,row);res.json(row);}catch(e:any){if(e?.code==='23505')return res.status(409).json({message:'Ezzel a kóddal már létezik rekord.'});next(e)}});

router.delete('/:entity/:id',async(req:AuthRequest,res,next)=>{const def=byKey.get(req.params.entity as any);if(!def)return next();try{const table=safe(tableOf[def.key]);const before=(await db.query(`SELECT * FROM ${table} WHERE id::text=$1 LIMIT 1`,[req.params.id])).rows[0];if(!before)return res.status(404).json({message:'A törzsadat nem található.'});const row=(await db.query(`UPDATE ${table} SET active=false,updated_at=now() WHERE id::text=$1 RETURNING *`,[req.params.id])).rows[0];await audit(req,def.key,req.params.id,'deactivate',before,row);res.json(row);}catch(e){next(e)}});

export default router;
