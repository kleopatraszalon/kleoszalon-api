import {Router,Response} from 'express';
import pool from '../db';
import {AuthRequest,requireAuth} from '../middleware/auth';

const router=Router();
const RECEPTION=new Set(['receptionist','reception','recepciós','recepcios']);
const roleList=(raw:unknown)=>{if(Array.isArray(raw))return raw.map(String).map(x=>x.toLowerCase());try{const p=JSON.parse(String(raw||''));if(Array.isArray(p))return p.map(String).map(x=>x.toLowerCase())}catch{}return String(raw||'').split(',').map(x=>x.replace(/[\[\]"]/g,'').trim().toLowerCase()).filter(Boolean)};
const isReceptionist=(req:AuthRequest)=>roleList(req.user?.role).some(r=>RECEPTION.has(r));
const optionalRows=async(label:string,promise:Promise<any>)=>{try{return (await promise).rows||[]}catch(error:any){console.warn(`[reception-client-context] ${label} unavailable`,error?.code||'',error?.message||error);return[]}};

router.get('/:id',requireAuth,async(req:AuthRequest,res:Response,next)=>{
  if(!isReceptionist(req))return next();
  const locationId=String(req.user?.location_id||'').trim();
  if(!locationId)return res.status(403).json({error:'A recepciós felhasználóhoz nincs szalon rendelve.'});
  try{
    const client=await pool.query(`
      SELECT c.*,
        COALESCE(NULLIF(to_jsonb(c)->>'full_name',''),NULLIF(to_jsonb(c)->>'name',''),'') display_name,
        l.name location_name
      FROM clients c
      LEFT JOIN locations l ON l.id::text=(to_jsonb(c)->>'location_id')
      WHERE c.id::text=$1
        AND (
          (to_jsonb(c)->>'location_id')=$2::text
          OR EXISTS(
            SELECT 1 FROM appointments a
            WHERE a.client_id::text=c.id::text AND a.location_id::text=$2::text
          )
          OR EXISTS(
            SELECT 1 FROM work_orders w
            WHERE w.client_id::text=c.id::text AND w.location_id::text=$2::text
          )
        )
      LIMIT 1`,[req.params.id,locationId]);
    if(!client.rowCount)return next();

    const [appointments,notes,tags,forms,loyalty,consents]=await Promise.all([
      optionalRows('appointments',pool.query(`
        SELECT a.id,a.start_time,a.end_time,a.status,a.title,l.name location_name,
          COALESCE(NULLIF(to_jsonb(e)->>'full_name',''),NULLIF(to_jsonb(e)->>'name',''),'') employee_name
        FROM appointments a
        LEFT JOIN locations l ON l.id::text=a.location_id::text
        LEFT JOIN employees e ON e.id::text=a.employee_id::text
        WHERE a.client_id::text=$1 AND a.location_id::text=$2::text
        ORDER BY a.start_time DESC LIMIT 100`,[req.params.id,locationId])),
      optionalRows('notes',pool.query(`SELECT * FROM crm_client_notes WHERE client_id::text=$1 ORDER BY created_at DESC`,[req.params.id])),
      optionalRows('tags',pool.query(`SELECT t.* FROM crm_client_tags ct JOIN crm_tags t ON t.id::text=ct.tag_id::text WHERE ct.client_id::text=$1 ORDER BY t.name`,[req.params.id])),
      optionalRows('forms',pool.query(`SELECT r.*,f.title,f.form_type FROM crm_form_responses r JOIN crm_forms f ON f.id::text=r.form_id::text WHERE r.client_id::text=$1 ORDER BY r.completed_at DESC`,[req.params.id])),
      optionalRows('loyalty',pool.query(`SELECT pm.*,t.name tier_name,t.color,t.discount_percent FROM loyalty_program_members pm LEFT JOIN loyalty_program_tiers t ON t.code=pm.tier_code WHERE pm.client_id::text=$1`,[req.params.id])),
      optionalRows('consents',pool.query(`SELECT * FROM crm_consent_history WHERE client_id::text=$1 ORDER BY created_at DESC LIMIT 20`,[req.params.id]))
    ]);

    res.json({client:client.rows[0],appointments,notes,tags,forms,loyalty:loyalty[0]||null,consents,scope:{location_id:locationId,receptionist:true}});
  }catch(error:any){
    console.error('[reception-client-context] failed',error);
    res.status(500).json({error:'A recepciós vendégadatok betöltése nem sikerült.',detail:error?.message||String(error)});
  }
});

export default router;
