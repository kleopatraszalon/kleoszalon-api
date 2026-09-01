import {Router,Response,NextFunction} from 'express';
import db from '../db';
import {withRuntimeSchemaBootstrapLock} from '../finance/ensureFinanceNav';
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
let readyPromise:Promise<void>|null=null;

async function ensureSchema(){
 if(ready)return;
 if(!readyPromise){
  readyPromise=withRuntimeSchemaBootstrapLock(async()=>{
   await db.query(`
 CREATE EXTENSION IF NOT EXISTS pgcrypto;
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

 CREATE TABLE IF NOT EXISTS salon_stock_requests(
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
   location_id uuid NOT NULL REFERENCES locations(id),
   product_id uuid NOT NULL REFERENCES products(id),
   requested_quantity numeric(14,3) NOT NULL CHECK(requested_quantity>0),
   approved_quantity numeric(14,3),
   supplied_quantity numeric(14,3) NOT NULL DEFAULT 0,
   status text NOT NULL DEFAULT 'requested' CHECK(status IN('requested','approved','partially_supplied','supplied','cancelled')),
   source text NOT NULL DEFAULT 'manual',
   source_work_order_id uuid,
   note text,
   created_by text,
   approved_by text,
   created_at timestamptz NOT NULL DEFAULT now(),
   approved_at timestamptz,
   updated_at timestamptz NOT NULL DEFAULT now()
 );
 CREATE INDEX IF NOT EXISTS salon_stock_requests_status_idx ON salon_stock_requests(status,location_id,created_at);
 ALTER TABLE salon_stock_requests ADD COLUMN IF NOT EXISTS purchase_order_id bigint;

 DO $$ BEGIN
   IF to_regclass('public.product_stock_balances') IS NOT NULL THEN
     ALTER TABLE product_stock_balances ADD COLUMN IF NOT EXISTS min_quantity numeric(14,3) NOT NULL DEFAULT 0;
   END IF;
 END $$;

 CREATE OR REPLACE FUNCTION kleo_auto_replenishment_from_workorder_consumption()
 RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE
   current_qty numeric(14,3);
   min_qty numeric(14,3);
   target_qty numeric(14,3);
   request_qty numeric(14,3);
 BEGIN
   IF NEW.movement_type <> 'work_order_consumption' OR NEW.location_id IS NULL THEN
     RETURN NEW;
   END IF;

   SELECT COALESCE(quantity,0),COALESCE(min_quantity,0)
     INTO current_qty,min_qty
     FROM product_stock_balances
    WHERE product_id=NEW.product_id AND location_id=NEW.location_id
    LIMIT 1;

   IF min_qty IS NULL OR min_qty<=0 OR current_qty>min_qty THEN
     RETURN NEW;
   END IF;

   IF EXISTS(
     SELECT 1 FROM salon_stock_requests
      WHERE location_id=NEW.location_id AND product_id=NEW.product_id
        AND status IN('requested','approved','partially_supplied')
   ) THEN
     RETURN NEW;
   END IF;

   target_qty:=GREATEST(min_qty*2,min_qty+ABS(COALESCE(NEW.quantity,0)));
   request_qty:=GREATEST(0.01,target_qty-current_qty);

   INSERT INTO salon_stock_requests(
     location_id,product_id,requested_quantity,status,source,source_work_order_id,note,created_by
   ) VALUES(
     NEW.location_id,NEW.product_id,request_qty,'requested','workorder_auto',NEW.work_order_id,
     'Automatikus készletfeltöltési igény: munkalap felhasználás után a készlet elérte vagy alulmúlta a minimumszintet.',
     'system:workorder-finalization'
   );
   RETURN NEW;
 END $$;

 DO $$ BEGIN
   IF to_regclass('public.inventory_movements') IS NOT NULL THEN
     DROP TRIGGER IF EXISTS trg_kleo_auto_replenishment_workorder ON inventory_movements;
     CREATE TRIGGER trg_kleo_auto_replenishment_workorder
       AFTER INSERT ON inventory_movements
       FOR EACH ROW
       WHEN (NEW.movement_type='work_order_consumption')
       EXECUTE FUNCTION kleo_auto_replenishment_from_workorder_consumption();
   END IF;
 END $$;

 DO $$ BEGIN
   IF to_regclass('public.stock_replenishment_requests') IS NOT NULL THEN
     INSERT INTO salon_stock_requests(location_id,product_id,requested_quantity,status,source,note,created_by,created_at,updated_at)
     SELECT r.location_id,r.product_id,r.requested_quantity,
            CASE WHEN r.status IN('approved','ordered') THEN 'approved' ELSE 'requested' END,
            'legacy_workorder',COALESCE(r.note,'Korábbi munkalap készletigény migrálva.'),r.created_by,r.created_at,COALESCE(r.updated_at,r.created_at)
       FROM stock_replenishment_requests r
      WHERE r.status IN('requested','approved','ordered')
        AND NOT EXISTS(
          SELECT 1 FROM salon_stock_requests s
           WHERE s.location_id=r.location_id AND s.product_id=r.product_id
             AND s.status IN('requested','approved','partially_supplied')
        );
   END IF;
 END $$;
 `);
   ready=true;
  }).catch(error=>{readyPromise=null;throw error});
 }
 return readyPromise;
}
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

router.post('/replenishment-request',async(req:AuthRequest,res,next)=>{try{await ensureSchema();if(!canEdit(req))return res.status(403).json({message:'Nincs jogosultság készletfeltöltési igény létrehozásához.'});const b=req.body||{},locationId=scopedLocation(req,String(b.location_id||''));if(!locationId)return res.status(400).json({message:'A szalon megadása kötelező.'});const productId=String(b.product_id||'').trim(),required=Math.max(0,Number(b.required_quantity||0)),available=Math.max(0,Number(b.available_quantity||0));const requested=Number(b.requested_quantity||Math.max(0.01,required-available));if(!(requested>0))return res.status(400).json({message:'Az igényelt mennyiségnek pozitívnak kell lennie.'});const product=(await db.query(`SELECT id::text,name FROM products WHERE id=$1::uuid AND COALESCE(is_active,true)=true`,[productId])).rows[0];if(!product)return res.status(404).json({message:'A termék nem található.'});const duplicate=(await db.query(`SELECT id::text,status,requested_quantity::numeric FROM salon_stock_requests WHERE location_id=$1::uuid AND product_id=$2::uuid AND status IN ('requested','approved','partially_supplied') ORDER BY created_at DESC LIMIT 1`,[locationId,productId])).rows[0];if(duplicate)return res.status(409).json({message:`Ehhez a termékhez már van nyitott központi készletigény.`,request:duplicate});const sourceWorkOrderId=String(b.source_work_order_id||b.source_ref||'').trim()||null;const {rows}=await db.query(`INSERT INTO salon_stock_requests(location_id,product_id,requested_quantity,source,source_work_order_id,note,created_by) VALUES($1::uuid,$2::uuid,$3,'workorder_draft',$4::uuid,$5,$6) RETURNING id::text,location_id::text,product_id::text,requested_quantity::numeric,approved_quantity::numeric,supplied_quantity::numeric,status,source,source_work_order_id::text,note,created_at`,[locationId,productId,requested,sourceWorkOrderId,String(b.note||'').trim()||`Munkalap anyaghiány: ${product.name}`,actor(req)]);res.status(201).json({...rows[0],product_name:product.name,canonical:true});
 }catch(e:any){if(e?.code==='22P02')return res.status(400).json({message:'Érvénytelen szalon-, termék- vagy munkalapazonosító.'});next(e)}});

router.get('/replenishment-requests',async(req:AuthRequest,res,next)=>{try{await ensureSchema();if(!canEdit(req))return res.status(403).json({message:'Nincs jogosultság a készletigényekhez.'});const locationId=scopedLocation(req,String(req.query.location_id||''));const params:any[]=[];let where='1=1';if(locationId){params.push(locationId);where+=` AND r.location_id=$${params.length}::uuid`}const {rows}=await db.query(`SELECT r.id::text,r.location_id::text,l.name location_name,r.product_id::text,p.name product_name,r.requested_quantity::numeric,r.approved_quantity::numeric,r.supplied_quantity::numeric,r.status,r.source,r.source_work_order_id::text,r.note,r.created_by,r.created_at,r.purchase_order_id FROM salon_stock_requests r JOIN locations l ON l.id=r.location_id JOIN products p ON p.id=r.product_id WHERE ${where} ORDER BY r.created_at DESC LIMIT 200`,params);res.json(rows)}catch(e){next(e)}});

export default router;
