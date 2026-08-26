import {Router,Response} from 'express';
import db from '../db';
import {requireAuth,type AuthRequest} from '../middleware/auth';
import {parseRoleKeys} from '../security/roles';
import {ensureFinanceNav} from '../finance/ensureFinanceNav';

const router=Router();
router.use(requireAuth);
const GLOBAL=new Set(['admin','manager','accounting','bookkeeper']);
const canChoose=new Set(['admin','manager','location_manager','salon_manager','receptionist']);
const actor=(req:AuthRequest)=>req.user?.email||String(req.user?.id||'');
function roles(req:AuthRequest){return parseRoleKeys(req.user?.role)}
function global(req:AuthRequest){return roles(req).some(r=>GLOBAL.has(r))}
function chooser(req:AuthRequest){return roles(req).some(r=>canChoose.has(r))}

router.post('/pending-selection',async(req:AuthRequest,res:Response)=>{try{
 await ensureFinanceNav();if(!chooser(req))return res.status(403).json({message:'Kibocsátó céget csak adminisztrátor, vezető vagy recepciós választhat.'});
 const legalEntityId=String(req.body?.legal_entity_id||'').trim();if(!legalEntityId)return res.status(400).json({message:'Válasszon kibocsátó céget.'});
 const ownLocation=String(req.user?.location_id||'').trim();
 const q=await db.query(`SELECT e.id::text,e.legal_name,e.short_name,e.tax_number,e.accounting_ledger_code,COALESCE(json_agg(json_build_object('id',l.id::text,'name',l.name,'city',l.city,'is_default',el.is_default) ORDER BY l.name) FILTER(WHERE l.id IS NOT NULL),'[]'::json) locations FROM legal_entities e LEFT JOIN legal_entity_locations el ON el.legal_entity_id=e.id AND el.active=true LEFT JOIN locations l ON l.id=el.location_id WHERE e.id::text=$1 AND e.active=true GROUP BY e.id`,[legalEntityId]);
 const entity=q.rows[0];if(!entity)return res.status(404).json({message:'A kiválasztott cég nem található vagy inaktív.'});
 if(!global(req)&&ownLocation&&!Array.isArray(entity.locations)||false)return res.status(403).json({message:'A cég nem választható.'});
 if(!global(req)&&ownLocation&&!entity.locations.some((x:any)=>String(x.id)===ownLocation))return res.status(403).json({message:'A kiválasztott cég nincs hozzárendelve a saját szalonhoz.'});
 await db.query(`INSERT INTO legal_entity_workorder_selections(actor_key,legal_entity_id,selected_at) VALUES($1,$2::uuid,now()) ON CONFLICT(actor_key) DO UPDATE SET legal_entity_id=EXCLUDED.legal_entity_id,selected_at=now()`,[actor(req),legalEntityId]);
 return res.json({ok:true,legal_entity:entity,expires_in_minutes:120,one_time:true});
 }catch(e:any){return res.status(500).json({message:e?.message||'A következő munkalap cége nem rögzíthető.'})}});

router.delete('/pending-selection',async(req:AuthRequest,res:Response)=>{try{await ensureFinanceNav();await db.query(`DELETE FROM legal_entity_workorder_selections WHERE actor_key=$1`,[actor(req)]);return res.json({ok:true})}catch(e:any){return res.status(500).json({message:e?.message||'A cégválasztás nem törölhető.'})}});

router.get('/workorders/:id',async(req:AuthRequest,res:Response)=>{try{
 await ensureFinanceNav();const wo=(await db.query(`SELECT w.id::text,w.work_order_number,w.location_id::text,w.legal_entity_id::text,w.financial_closed_at,w.fully_paid,w.payment_status,e.legal_name,e.short_name,e.tax_number,e.accounting_ledger_code FROM work_orders w LEFT JOIN legal_entities e ON e.id=w.legal_entity_id WHERE w.id::text=$1`,[req.params.id])).rows[0];if(!wo)return res.status(404).json({message:'A munkalap nem található.'});if(!global(req)&&String(req.user?.location_id||'')!==String(wo.location_id||''))return res.status(403).json({message:'Másik szalon munkalapja nem érhető el.'});
 const choices=(await db.query(`SELECT e.id::text,e.legal_name,e.short_name,e.tax_number,e.accounting_ledger_code,el.is_default FROM legal_entities e JOIN legal_entity_locations el ON el.legal_entity_id=e.id WHERE el.location_id::text=$1 AND el.active=true AND e.active=true ORDER BY el.is_default DESC,e.legal_name`,[wo.location_id])).rows;
 return res.json({ok:true,work_order:wo,choices,locked:Boolean(wo.financial_closed_at||wo.fully_paid||String(wo.payment_status||'')==='paid')});
 }catch(e:any){return res.status(500).json({message:e?.message||'A munkalap cége nem tölthető be.'})}});

router.put('/workorders/:id',async(req:AuthRequest,res:Response)=>{const c=await db.connect();try{
 await ensureFinanceNav();if(!chooser(req))return res.status(403).json({message:'A munkalap kibocsátó cégét csak adminisztrátor, vezető vagy recepciós választhatja ki.'});const legalEntityId=String(req.body?.legal_entity_id||'').trim();if(!legalEntityId)return res.status(400).json({message:'Válasszon céget.'});await c.query('BEGIN');
 const wo=(await c.query(`SELECT w.id::text,w.work_order_number,w.location_id::text,w.legal_entity_id::text,w.financial_closed_at,w.fully_paid,w.payment_status FROM work_orders w WHERE w.id::text=$1 FOR UPDATE`,[req.params.id])).rows[0];if(!wo){await c.query('ROLLBACK');return res.status(404).json({message:'A munkalap nem található.'})}if(!global(req)&&String(req.user?.location_id||'')!==String(wo.location_id||'')){await c.query('ROLLBACK');return res.status(403).json({message:'Másik szalon munkalapja nem módosítható.'})}
 const choice=(await c.query(`SELECT e.id::text,e.legal_name,e.tax_number,e.accounting_ledger_code FROM legal_entities e JOIN legal_entity_locations el ON el.legal_entity_id=e.id WHERE e.id::text=$1 AND el.location_id::text=$2 AND e.active=true AND el.active=true`,[legalEntityId,wo.location_id])).rows[0];if(!choice){await c.query('ROLLBACK');return res.status(409).json({message:'A kiválasztott cég nincs aktívan hozzárendelve ehhez a szalonhoz.'})}
 if(String(wo.legal_entity_id||'')===legalEntityId){await c.query('COMMIT');return res.json({ok:true,work_order:{...wo,legal_entity_id:legalEntityId},legal_entity:choice,idempotent:true})}
 await c.query(`UPDATE work_orders SET legal_entity_id=$2::uuid WHERE id::text=$1`,[wo.id,legalEntityId]);
 await c.query(`CREATE TABLE IF NOT EXISTS legal_entity_audit_log(id bigserial PRIMARY KEY,legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,event_type text NOT NULL,actor text,payload jsonb NOT NULL DEFAULT '{}'::jsonb,created_at timestamptz NOT NULL DEFAULT now())`);
 await c.query(`INSERT INTO legal_entity_audit_log(legal_entity_id,event_type,actor,payload) VALUES($1,'WORK_ORDER_ASSIGNED',$2,$3::jsonb)`,[legalEntityId,actor(req),JSON.stringify({work_order_id:wo.id,work_order_number:wo.work_order_number,previous_legal_entity_id:wo.legal_entity_id,location_id:wo.location_id})]);await c.query('COMMIT');return res.json({ok:true,work_order:{...wo,legal_entity_id:legalEntityId},legal_entity:choice});
 }catch(e:any){await c.query('ROLLBACK').catch(()=>undefined);const msg=String(e?.message||'A munkalap cége nem módosítható.');return res.status(e?.code==='23514'?409:500).json({message:msg})}finally{c.release()}});

export default router;
