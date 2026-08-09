import {Router,Response,NextFunction} from 'express';
import db from '../db';
import {requireAuth,AuthRequest} from '../middleware/auth';

const router=Router();
router.use(requireAuth);
const ADMIN=['admin','administrator','rendszergazda','superadmin','super_admin'];
const EDITORS=['receptionist','recepciós','recepcios','reception','location_manager','üzletvezető','uzletvezeto','store_manager','branch_manager'];
const roles=(raw:any)=>{if(Array.isArray(raw))return raw.map(String).map(x=>x.toLowerCase());try{const p=JSON.parse(String(raw||''));if(Array.isArray(p))return p.map(String).map(x=>x.toLowerCase())}catch{}return String(raw||'').split(',').map(x=>x.replace(/[\[\]"]/g,'').trim().toLowerCase()).filter(Boolean)};
const isAdmin=(req:AuthRequest)=>roles(req.user?.role).some(r=>ADMIN.includes(r));
const canEdit=(req:AuthRequest)=>isAdmin(req)||roles(req.user?.role).some(r=>EDITORS.includes(r));
const actor=(req:AuthRequest)=>req.user?.email||String(req.user?.id||'');
let ready=false;
async function ensureSchema(){if(ready)return;await db.query(`
 CREATE TABLE IF NOT EXISTS service_material_requirements(
   id bigserial PRIMARY KEY,
   service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
   product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
   default_quantity numeric(14,3) NOT NULL DEFAULT 1,
   unit text NOT NULL DEFAULT 'db',
   required boolean NOT NULL DEFAULT true,
   active boolean NOT NULL DEFAULT true,
   note text,
   created_at timestamptz NOT NULL DEFAULT now(),
   updated_at timestamptz NOT NULL DEFAULT now(),
   UNIQUE(service_id,product_id)
 );
 CREATE INDEX IF NOT EXISTS service_material_requirements_service_idx ON service_material_requirements(service_id) WHERE active=true;
 CREATE TABLE IF NOT EXISTS stock_replenishment_requests(
   id bigserial PRIMARY KEY,
   location_id uuid NOT NULL REFERENCES locations(id),
   product_id uuid NOT NULL REFERENCES products(id),
   requested_quantity numeric(14,3) NOT NULL,
   available_quantity numeric(14,3) NOT NULL DEFAULT 0,
   required_quantity numeric(14,3) NOT NULL DEFAULT 0,
   status text NOT NULL DEFAULT 'requested',
   source_type text NOT NULL DEFAULT 'workorder_draft',
   source_ref text,
   note text,
   created_by text,
   created_at timestamptz NOT NULL DEFAULT now(),
   updated_at timestamptz NOT NULL DEFAULT now(),
   CONSTRAINT stock_replenishment_requests_status_ck CHECK(status IN ('requested','approved','ordered','fulfilled','rejected','cancelled')),
   CONSTRAINT stock_replenishment_requests_qty_ck CHECK(requested_quantity>0)
 );
 CREATE INDEX IF NOT EXISTS stock_replenishment_requests_location_status_idx ON stock_replenishment_requests(location_id,status,created_at DESC);
 `);ready=true}
function scopedLocation(req:AuthRequest,requested:string){if(isAdmin(req))return requested;return req.user?.location_id?String(req.user.location_id):''}

router.get('/plan',async(req:AuthRequest,res,next)=>{try{await ensureSchema();if(!canEdit(req))return res.status(403).json({message:'Nincs jogosultság a munkalap anyagtervéhez.'});const locationId=scopedLocation(req,String(req.query.location_id||''));const raw=String(req.query.service_ids||'').split(',').map(x=>x.trim()).filter(Boolean);if(!raw.length)return res.json({requirements:[],missing_required:0});const params:any[]=[raw];let stockJoin=`LEFT JOIN product_stock_balances b ON false`;if(locationId){params.push(locationId);stockJoin=`LEFT JOIN product_stock_balances b ON b.product_id=p.id AND b.location_id::text=$2`}const {rows}=await db.query(`
 SELECT r.id::text,r.service_id::text,r.product_id::text,r.default_quantity::numeric,r.unit,r.required,r.note,
        s.name service_name,p.name product_name,COALESCE(p.retail_price_gross,0)::numeric unit_price,
        ${locationId?'COALESCE(b.quantity,0)::numeric':'NULL::numeric'} available_stock,
        ${locationId?'COALESCE(b.min_quantity,0)::numeric':'NULL::numeric'} min_quantity
 FROM service_material_requirements r
 JOIN services s ON s.id=r.service_id
 JOIN products p ON p.id=r.product_id
 ${stockJoin}
 WHERE r.active=true AND r.service_id=ANY($1::uuid[]) AND COALESCE(p.is_active,true)=true
 ORDER BY s.name,p.name`,params);
 res.json({requirements:rows,missing_required:locationId?rows.filter((x:any)=>x.required&&Number(x.available_stock||0)<Number(x.default_quantity||0)).length:0});
 }catch(e:any){if(e?.code==='22P02')return res.status(400).json({message:'Érvénytelen szalon- vagy szolgáltatásazonosító.'});next(e)}});

router.post('/replenishment-request',async(req:AuthRequest,res,next)=>{try{await ensureSchema();if(!canEdit(req))return res.status(403).json({message:'Nincs jogosultság készletfeltöltési igény létrehozásához.'});const b=req.body||{},locationId=scopedLocation(req,String(b.location_id||''));if(!locationId)return res.status(400).json({message:'A szalon megadása kötelező.'});const productId=String(b.product_id||'').trim(),required=Math.max(0,Number(b.required_quantity||0)),available=Math.max(0,Number(b.available_quantity||0));const requested=Number(b.requested_quantity||Math.max(0.01,required-available));if(!(requested>0))return res.status(400).json({message:'Az igényelt mennyiségnek pozitívnak kell lennie.'});const product=(await db.query(`SELECT id::text,name FROM products WHERE id=$1::uuid AND COALESCE(is_active,true)=true`,[productId])).rows[0];if(!product)return res.status(404).json({message:'A termék nem található.'});const duplicate=(await db.query(`SELECT id::text,status,requested_quantity::numeric FROM stock_replenishment_requests WHERE location_id=$1::uuid AND product_id=$2::uuid AND status IN ('requested','approved','ordered') ORDER BY created_at DESC LIMIT 1`,[locationId,productId])).rows[0];if(duplicate)return res.status(409).json({message:`Ehhez a termékhez már van nyitott készletigény (#${duplicate.id}).`,request:duplicate});const {rows}=await db.query(`INSERT INTO stock_replenishment_requests(location_id,product_id,requested_quantity,available_quantity,required_quantity,source_type,source_ref,note,created_by) VALUES($1::uuid,$2::uuid,$3,$4,$5,'workorder_draft',$6,$7,$8) RETURNING id::text,location_id::text,product_id::text,requested_quantity::numeric,available_quantity::numeric,required_quantity::numeric,status,source_ref,note,created_at`,[locationId,productId,requested,available,required,String(b.source_ref||'').trim()||null,String(b.note||'').trim()||`Munkalap anyaghiány: ${product.name}`,actor(req)]);res.status(201).json({...rows[0],product_name:product.name});
 }catch(e:any){if(e?.code==='22P02')return res.status(400).json({message:'Érvénytelen szalon- vagy termékazonosító.'});next(e)}});

router.get('/replenishment-requests',async(req:AuthRequest,res,next)=>{try{await ensureSchema();if(!canEdit(req))return res.status(403).json({message:'Nincs jogosultság a készletigényekhez.'});const locationId=scopedLocation(req,String(req.query.location_id||''));const params:any[]=[];let where='1=1';if(locationId){params.push(locationId);where+=` AND r.location_id=$${params.length}::uuid`}const {rows}=await db.query(`SELECT r.id::text,r.location_id::text,l.name location_name,r.product_id::text,p.name product_name,r.requested_quantity::numeric,r.available_quantity::numeric,r.required_quantity::numeric,r.status,r.source_type,r.source_ref,r.note,r.created_by,r.created_at FROM stock_replenishment_requests r JOIN locations l ON l.id=r.location_id JOIN products p ON p.id=r.product_id WHERE ${where} ORDER BY r.created_at DESC LIMIT 200`,params);res.json(rows)}catch(e){next(e)}});
export default router;
