import {Router} from 'express';
import db from '../db';

const router=Router();
const normalizePhone=(v:any)=>String(v||'').replace(/[^0-9]/g,'');
async function ensureSchema(){await db.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS merged_into_client_id uuid;CREATE TABLE IF NOT EXISTS client_booking_controls(client_id uuid PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,online_booking_blocked boolean NOT NULL DEFAULT false,block_reason text,updated_by text,updated_at timestamptz NOT NULL DEFAULT now())`)}
router.use(async(req,res,next)=>{try{
 if(req.method!=='POST'||!['/book','/waitlist'].includes(String(req.path||'')))return next();
 await ensureSchema();const locationId=String(req.body?.location_id||'').trim(),email=String(req.body?.email||'').trim().toLowerCase(),phone=normalizePhone(req.body?.phone);if(!locationId||(!email&&!phone))return next();
 const {rows}=await db.query(`WITH matched AS(
   SELECT c.id,c.merged_into_client_id FROM clients c WHERE c.location_id::text=$1 AND (($2<>'' AND lower(COALESCE(c.email,''))=$2) OR ($3<>'' AND regexp_replace(COALESCE(c.phone,''),'[^0-9]','','g')=$3)) ORDER BY c.updated_at DESC NULLS LAST LIMIT 5
 ),resolved AS(
   SELECT COALESCE(m.merged_into_client_id,m.id) client_id FROM matched m
 )
 SELECT DISTINCT r.client_id::text,c.online_booking_blocked,c.block_reason FROM resolved r LEFT JOIN client_booking_controls c ON c.client_id=r.client_id WHERE COALESCE(c.online_booking_blocked,false)=true LIMIT 1`,[locationId,email,phone]);
 if(rows[0])return res.status(403).json({error:'Ehhez az ügyfélhez online foglalás jelenleg nem engedélyezett. Kérjük, vegye fel a kapcsolatot a szalonnal.',code:'ONLINE_BOOKING_BLOCKED'});
 next();
 }catch(e){next(e)}});
export default router;
