import {Router,Response,NextFunction} from 'express';
import db from '../db';
import {requireAuth,AuthRequest} from '../middleware/auth';
import {hasAnyRole} from '../security/roles';

const router=Router();
router.use(requireAuth);

type CacheEntry={expires:number;value:any};
const cache=new Map<string,CacheEntry>();
const TTL_MS=10000;

const canEdit=(role:unknown)=>hasAnyRole(role,['admin','receptionist','location_manager']);
const isAdmin=(role:unknown)=>hasAnyRole(role,['admin']);

async function locationsFor(req:AuthRequest){
  if(isAdmin(req.user?.role))return (await db.query(`SELECT id::text,name,city,address FROM locations WHERE COALESCE(is_active,true)=true ORDER BY city,name`)).rows;
  const locationId=String(req.user?.location_id||'');
  if(!locationId)return [];
  return (await db.query(`SELECT id::text,name,city,address FROM locations WHERE id::text=$1 AND COALESCE(is_active,true)=true LIMIT 1`,[locationId])).rows;
}

router.get('/options',async(req:AuthRequest,res:Response,next:NextFunction)=>{
  try{
    // Időpontból történő új munkalap-létrehozást a teljes editor route kezelje.
    if(String(req.query.appointment_id||'').trim())return next();
    if(!canEdit(req.user?.role))return next();

    const admin=isAdmin(req.user?.role);
    const requestedLocation=String(req.query.location_id||'').trim();
    const locationId=admin?requestedLocation:String(req.user?.location_id||'');
    const locationsPromise=locationsFor(req);

    if(!locationId){
      const locations=await locationsPromise;
      return res.json({scope:{is_admin:admin,location_id:null},locations,location:null,employees:[],clients:[],services:[],products:[],fast:true});
    }

    const requestedEmployee=String(req.query.employee_id||'').trim();
    const key=`${locationId}:${requestedEmployee||'-'}`;
    const cached=cache.get(key);
    if(cached&&cached.expires>Date.now()){
      const locations=await locationsPromise;
      return res.json({...cached.value,locations,fast:true,cached:true});
    }

    if(requestedEmployee){
      const ok=await db.query(`SELECT 1 FROM employees WHERE id::text=$1 AND location_id::text=$2 AND COALESCE(active,true)=true LIMIT 1`,[requestedEmployee,locationId]);
      if(!ok.rows[0])return res.status(400).json({message:'A kiválasztott munkatárs nem ehhez a szalonhoz tartozik.'});
    }

    const [locationQ,employeesQ,clientsQ,servicesQ,productsQ,locations]=await Promise.all([
      db.query(`SELECT id::text,name,city,address FROM locations WHERE id::text=$1 AND COALESCE(is_active,true)=true LIMIT 1`,[locationId]),
      db.query(`SELECT id::text,full_name,email,phone,position_id::text,location_id::text FROM employees WHERE location_id::text=$1 AND COALESCE(active,true)=true ORDER BY full_name`,[locationId]),
      db.query(`SELECT id::text,COALESCE(NULLIF(full_name,''),name) name,phone,email,location_id::text FROM clients WHERE location_id::text=$1 AND COALESCE(is_active,true)=true ORDER BY COALESCE(NULLIF(full_name,''),name) LIMIT 500`,[locationId]),
      db.query(`SELECT s.id::text,s.name,COALESCE(eo.custom_price,s.promo_price,s.list_price,s.base_price,0)::numeric price,COALESCE(eo.custom_duration_minutes,s.duration_minutes,30)::int duration_minutes FROM services s LEFT JOIN employee_service_overrides eo ON eo.service_id=s.id AND eo.employee_id::text=NULLIF($2,'') WHERE COALESCE(s.is_active,true)=true AND EXISTS(SELECT 1 FROM service_locations sl WHERE sl.service_id=s.id AND sl.location_id::text=$1) AND (NULLIF($2,'') IS NULL OR eo.service_id IS NOT NULL) ORDER BY s.name`,[locationId,requestedEmployee]),
      db.query(`SELECT p.id::text,p.name,COALESCE(p.retail_price_gross,0)::numeric price,'db'::text unit,COALESCE(b.quantity,0)::numeric available_stock FROM products p LEFT JOIN product_stock_balances b ON b.product_id=p.id AND b.location_id::text=$1 WHERE COALESCE(p.is_active,true)=true ORDER BY p.name`,[locationId]),
      locationsPromise,
    ]);

    const location=locationQ.rows[0];
    if(!location)return res.status(400).json({message:'A kiválasztott szalon nem található vagy nem aktív.'});
    const value={scope:{is_admin:admin,location_id:locationId},location,employees:employeesQ.rows,clients:clientsQ.rows,services:servicesQ.rows,products:productsQ.rows,appointment:null};
    cache.set(key,{expires:Date.now()+TTL_MS,value});
    return res.json({...value,locations,fast:true,cached:false});
  }catch(e){next(e)}
});

export default router;
