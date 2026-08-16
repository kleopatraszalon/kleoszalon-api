import {Router} from 'express';
import db from '../db';
import {requireAuth,AuthRequest} from '../middleware/auth';
import {clientLatenessStats} from '../services/clientLateness';

const router=Router();
router.use(requireAuth);
const isAdmin=(role:unknown)=>String(role||'').toLowerCase().includes('admin');
async function rows(query:Promise<any>){try{return(await query).rows||[]}catch(error:any){console.warn('[client-detail-recovery] optional query skipped',error?.code||'',error?.message||error);return[]}}

router.get('/:id',async(req:AuthRequest,res,next)=>{
 try{
  const locationId=isAdmin(req.user?.role)?String(req.query.location_id||'').trim():String(req.user?.location_id||'').trim();
  const client=(await db.query(`SELECT c.*,
      COALESCE(NULLIF(to_jsonb(c)->>'full_name',''),NULLIF(to_jsonb(c)->>'name',''),'') display_name,
      (SELECT name FROM locations l WHERE l.id::text=NULLIF(to_jsonb(c)->>'location_id','') LIMIT 1) location_name
    FROM clients c
    WHERE c.id::text=$1 AND ($2::text='' OR NULLIF(to_jsonb(c)->>'location_id','')=$2)
    LIMIT 1`,[req.params.id,locationId])).rows[0];
  if(!client)return res.status(404).json({error:'Az ügyfél nem található.'});
  const [appointments,notes,tags,forms,loyalty,consents,lateness]=await Promise.all([
    rows(db.query(`SELECT a.id,a.start_time,a.end_time,a.status,a.title,
      NULLIF(to_jsonb(a)->>'arrived_at','') arrived_at,
      CASE WHEN COALESCE(to_jsonb(a)->>'late_minutes','')~'^\\d+$' THEN (to_jsonb(a)->>'late_minutes')::int ELSE 0 END late_minutes,
      (SELECT name FROM locations l WHERE l.id::text=a.location_id::text LIMIT 1) location_name,
      (SELECT COALESCE(NULLIF(to_jsonb(e)->>'full_name',''),NULLIF(to_jsonb(e)->>'name',''),'') FROM employees e WHERE e.id::text=a.employee_id::text LIMIT 1) employee_name
      FROM appointments a WHERE a.client_id::text=$1 ORDER BY a.start_time DESC LIMIT 100`,[req.params.id])),
    rows(db.query(`SELECT * FROM crm_client_notes WHERE client_id::text=$1 ORDER BY created_at DESC`,[req.params.id])),
    rows(db.query(`SELECT t.* FROM crm_client_tags ct JOIN crm_tags t ON t.id::text=ct.tag_id::text WHERE ct.client_id::text=$1 ORDER BY t.name`,[req.params.id])),
    rows(db.query(`SELECT r.*,f.title,f.form_type FROM crm_form_responses r JOIN crm_forms f ON f.id::text=r.form_id::text WHERE r.client_id::text=$1 ORDER BY r.completed_at DESC`,[req.params.id])),
    rows(db.query(`SELECT pm.*,t.name tier_name,t.color,t.discount_percent FROM loyalty_program_members pm LEFT JOIN loyalty_program_tiers t ON t.code=pm.tier_code WHERE pm.client_id::text=$1`,[req.params.id])),
    rows(db.query(`SELECT * FROM crm_consent_history WHERE client_id::text=$1 ORDER BY created_at DESC LIMIT 20`,[req.params.id])),
    clientLatenessStats(String(req.params.id)).catch(()=>({attended:0,late_count:0,late_percentage:0,max_late_minutes:0,grace_minutes:5}))
  ]);
  return res.json({client,appointments,notes,tags,forms,loyalty:loyalty[0]||null,consents,lateness,recovery:true});
 }catch(error:any){
  if(error?.code==='22P02')return res.status(400).json({error:'Érvénytelen ügyfélazonosító.'});
  return next(error);
 }
});

export default router;
