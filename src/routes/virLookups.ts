import {Router,Response} from 'express';
import pool from '../db';
import type {AuthRequest} from '../middleware/auth';
import {requireManagement} from '../middleware/requireRoles';
import {resolveTenantIdentity} from '../saas/tenantAccess';

const router=Router();
router.use(requireManagement);
const text=(v:unknown)=>String(v??'').trim();

async function tenant(req:AuthRequest,res:Response){
  const identity=await resolveTenantIdentity(req);
  if(!identity){res.status(403).json({ok:false,error:'tenant_unavailable',message:'A fiókhoz nem sikerült biztonságosan telephelyi/tenant környezetet meghatározni.'});return null;}
  return identity.id;
}

router.get('/context',async(req:AuthRequest,res:Response)=>{
  const identity=await resolveTenantIdentity(req);
  if(!identity)return res.status(403).json({ok:false,error:'tenant_unavailable'});
  const locations=(await pool.query(`SELECT id::text,name FROM locations WHERE tenant_id=$1::uuid ORDER BY name`,[identity.id])).rows;
  res.json({ok:true,tenant:{id:identity.id,slug:identity.slug,role:identity.role},locations});
});

router.get('/clients',async(req:AuthRequest,res:Response)=>{
  const t=await tenant(req,res);if(!t)return;
  const q=text(req.query.q).slice(0,80);
  const rows=(await pool.query(`SELECT c.id::text id,c.full_name label,c.phone,c.email
    FROM clients c
    WHERE EXISTS(SELECT 1 FROM appointments a WHERE a.tenant_id=$1::uuid AND a.client_id=c.id)
      AND ($2::text='' OR COALESCE(c.full_name,'') ILIKE '%'||$2||'%' OR COALESCE(c.phone,'') ILIKE '%'||$2||'%' OR COALESCE(c.email,'') ILIKE '%'||$2||'%')
    ORDER BY c.full_name NULLS LAST
    LIMIT 80`,[t,q])).rows;
  res.json({ok:true,items:rows});
});

router.get('/locations',async(req:AuthRequest,res:Response)=>{
  const t=await tenant(req,res);if(!t)return;
  const q=text(req.query.q).slice(0,80);
  const rows=(await pool.query(`SELECT id::text id,name label FROM locations WHERE tenant_id=$1::uuid AND ($2::text='' OR name ILIKE '%'||$2||'%') ORDER BY name LIMIT 80`,[t,q])).rows;
  res.json({ok:true,items:rows});
});

router.get('/work-orders',async(req:AuthRequest,res:Response)=>{
  const t=await tenant(req,res);if(!t)return;
  const q=text(req.query.q).slice(0,80);
  const rows=(await pool.query(`SELECT w.id::text id,('Munkalap · '||left(w.id::text,8)||' · '||COALESCE(w.status,'ismeretlen')) label,w.status,w.location_id::text
    FROM work_orders w
    WHERE w.tenant_id=$1::uuid AND ($2::text='' OR w.id::text ILIKE '%'||$2||'%' OR COALESCE(w.status,'') ILIKE '%'||$2||'%')
    ORDER BY w.id DESC LIMIT 80`,[t,q])).rows;
  res.json({ok:true,items:rows});
});

export default router;
