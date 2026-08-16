import {Router,Response,NextFunction} from 'express';
import db from '../db';
import {requireAuth,AuthRequest} from '../middleware/auth';
import {hasAnyRole} from '../security/roles';

const router=Router();
router.use(requireAuth);

type CacheEntry={expires:number;value:any};
const cache=new Map<string,CacheEntry>();
// A munkalap szerkesztő törzsadatai ritkán változnak, ezért ne kérdezzük le őket
// minden megnyitásnál újra. A korábbi 10 mp-es TTL gyakorlatilag nem adott érezhető gyorsulást.
const TTL_MS=5*60*1000;
const LOCATION_TTL_MS=5*60*1000;
let adminLocationsCache:CacheEntry|null=null;
const scopedLocationCache=new Map<string,CacheEntry>();

const canEdit=(role:unknown)=>hasAnyRole(role,['admin','receptionist','location_manager']);
const isAdmin=(role:unknown)=>hasAnyRole(role,['admin']);

async function optionalRows(label:string,query:Promise<any>){
  try{return (await query).rows||[]}
  catch(error:any){console.warn(`[workorder-editor-fast] ${label} unavailable`,error?.code||'',error?.message||error);return[]}
}

async function locationsFor(req:AuthRequest){
  const now=Date.now();
  if(isAdmin(req.user?.role)){
    if(adminLocationsCache&&adminLocationsCache.expires>now)return adminLocationsCache.value;
    const rows=(await db.query(`SELECT id::text,name,city,address FROM locations WHERE COALESCE(is_active,true)=true ORDER BY city,name`)).rows;
    adminLocationsCache={expires:now+LOCATION_TTL_MS,value:rows};
    return rows;
  }
  const locationId=String(req.user?.location_id||'');
  if(!locationId)return [];
  const hit=scopedLocationCache.get(locationId);
  if(hit&&hit.expires>now)return hit.value;
  const rows=(await db.query(`SELECT id::text,name,city,address FROM locations WHERE id::text=$1 AND COALESCE(is_active,true)=true LIMIT 1`,[locationId])).rows;
  scopedLocationCache.set(locationId,{expires:now+LOCATION_TTL_MS,value:rows});
  return rows;
}

function cleanupCache(){
  if(cache.size<200&&scopedLocationCache.size<100)return;
  const now=Date.now();
  for(const [key,value] of cache)if(value.expires<=now)cache.delete(key);
  for(const [key,value] of scopedLocationCache)if(value.expires<=now)scopedLocationCache.delete(key);
}

router.get('/options',async(req:AuthRequest,res:Response,next:NextFunction)=>{
  try{
    // Időpontból történő új munkalap-létrehozást a teljes editor route kezelje.
    if(String(req.query.appointment_id||'').trim())return next();
    if(!canEdit(req.user?.role))return next();

    cleanupCache();
    const admin=isAdmin(req.user?.role);
    const requestedLocation=String(req.query.location_id||'').trim();
    const locationId=admin?requestedLocation:String(req.user?.location_id||'');
    const locationsPromise=locationsFor(req);

    if(!locationId){
      const locations=await locationsPromise;
      return res.json({scope:{is_admin:admin,location_id:null},locations,location:null,employees:[],clients:[],services:[],products:[],fast:true});
    }

    const requestedEmployee=String(req.query.employee_id||'').trim();
    // Cache entries must be authorization-scope specific. Without the scope
    // discriminator an admin response could be served to a receptionist or
    // location manager who happens to request the same location/employee.
    const key=`${admin?'admin':'scoped'}:${locationId}:${requestedEmployee||'-'}`;
    const cached=cache.get(key);
    if(cached&&cached.expires>Date.now()){
      const locations=await locationsPromise;
      res.setHeader('X-Kleo-Workorder-Editor-Cache','HIT');
      return res.json({...cached.value,locations,fast:true,cached:true});
    }

    if(requestedEmployee){
      const ok=await db.query(`SELECT 1 FROM employees WHERE id::text=$1 AND location_id::text=$2 AND COALESCE(active,true)=true LIMIT 1`,[requestedEmployee,locationId]);
      if(!ok.rows[0])return res.status(400).json({message:'A kiválasztott munkatárs nem ehhez a szalonhoz tartozik.'});
    }

    const [locationQ,employees,clients,services,products,locations]=await Promise.all([
      db.query(`SELECT id::text,name,city,address FROM locations WHERE id::text=$1 AND COALESCE(is_active,true)=true LIMIT 1`,[locationId]),
      optionalRows('employees',db.query(`SELECT id::text,full_name,email,phone,position_id::text,location_id::text FROM employees WHERE location_id::text=$1 AND COALESCE(active,true)=true ORDER BY full_name`,[locationId])),
      optionalRows('clients',db.query(`SELECT id::text,COALESCE(NULLIF(to_jsonb(clients)->>'full_name',''),NULLIF(to_jsonb(clients)->>'name',''),'') name,to_jsonb(clients)->>'phone' phone,to_jsonb(clients)->>'email' email,to_jsonb(clients)->>'location_id' location_id FROM clients WHERE to_jsonb(clients)->>'location_id'=$1 AND COALESCE(NULLIF(to_jsonb(clients)->>'is_active','')::boolean,true)=true ORDER BY 2 LIMIT 500`,[locationId])),
      optionalRows('services',db.query(`SELECT s.id::text,s.name,COALESCE(NULLIF(to_jsonb(eo)->>'custom_price','')::numeric,NULLIF(to_jsonb(s)->>'promo_price','')::numeric,NULLIF(to_jsonb(s)->>'list_price','')::numeric,NULLIF(to_jsonb(s)->>'base_price','')::numeric,0)::numeric price,COALESCE(NULLIF(to_jsonb(eo)->>'custom_duration_minutes','')::int,NULLIF(to_jsonb(s)->>'duration_minutes','')::int,30)::int duration_minutes FROM services s LEFT JOIN employee_service_overrides eo ON eo.service_id::text=s.id::text AND eo.employee_id::text=NULLIF($2,'') WHERE COALESCE(NULLIF(to_jsonb(s)->>'is_active','')::boolean,true)=true AND EXISTS(SELECT 1 FROM service_locations sl WHERE sl.service_id::text=s.id::text AND sl.location_id::text=$1) AND (NULLIF($2,'') IS NULL OR eo.service_id IS NOT NULL) ORDER BY s.name`,[locationId,requestedEmployee])),
      optionalRows('products',db.query(`SELECT p.id::text,p.name,COALESCE(NULLIF(to_jsonb(p)->>'retail_price_gross','')::numeric,0)::numeric price,'db'::text unit,COALESCE(NULLIF(to_jsonb(b)->>'quantity','')::numeric,0)::numeric available_stock FROM products p LEFT JOIN product_stock_balances b ON b.product_id::text=p.id::text AND b.location_id::text=$1 WHERE COALESCE(NULLIF(to_jsonb(p)->>'is_active','')::boolean,true)=true ORDER BY p.name`,[locationId])),
      locationsPromise,
    ]);

    const location=locationQ.rows[0];
    if(!location)return res.status(400).json({message:'A kiválasztott szalon nem található vagy nem aktív.'});
    const value={scope:{is_admin:admin,location_id:locationId},location,employees,clients,services,products,appointment:null};
    cache.set(key,{expires:Date.now()+TTL_MS,value});
    res.setHeader('X-Kleo-Workorder-Editor-Cache','MISS');
    return res.json({...value,locations,fast:true,cached:false});
  }catch(e){next(e)}
});

export default router;
