import { Router, Response } from "express";
import pool from "../db";
import type { AuthRequest } from "../middleware/auth";
import { requireManagement } from "../middleware/requireRoles";
import { locationBelongsToTenant } from "../saas/tenantAccess";

const router=Router();
router.use(requireManagement);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function tenantId(req:AuthRequest,res:Response):string|undefined{const value=String(req.user?.tenant_id??"").trim();if(!/^\d+$/.test(value)||Number(value)<=0){res.status(403).json({ok:false,error:"tenant_context_required"});return;}return value;}
function actorId(req:AuthRequest):string{return String(req.user?.id??req.user?.employee_id??"system");}
async function validateLocation(locationId:unknown,tenant:string,res:Response):Promise<string|null|undefined>{const value=String(locationId??"").trim();if(!value)return null;if(!UUID.test(value)){res.status(400).json({ok:false,error:"invalid_location_id"});return;}if(!(await locationBelongsToTenant(value,tenant))){res.status(403).json({ok:false,error:"tenant_location_mismatch"});return;}return value;}
function priorityToRisk(priority:string):string{return priority==="critical"?"critical":priority==="high"?"high":priority==="low"?"low":"medium";}
function operationForArea(area:string,action:any):string{const a=String(action?.type??"").toUpperCase();const x=String(area??"").toUpperCase();if(a.includes("SHIFT")||x.includes("OPERATIONS"))return "staffing_review";if(a.includes("DEPOSIT")||x.includes("REVENUE"))return "revenue_review";if(x.includes("CUSTOMER"))return "customer_retention_review";if(x.includes("INVENTORY"))return "inventory_review";return "manual_task";}
async function safeQuery(sql:string,args:any[]=[]):Promise<any[]>{try{return (await pool.query(sql,args)).rows;}catch{return [];}}

router.get("/status",async(req:AuthRequest,res:Response)=>{const tenant=tenantId(req,res);if(!tenant)return;try{const counts=(await pool.query(`SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE status='proposed')::int proposed,COUNT(*) FILTER(WHERE status='promoted')::int promoted,COUNT(*) FILTER(WHERE status='dismissed')::int dismissed FROM vir_p18_proposals WHERE tenant_id=$1::bigint`,[tenant])).rows[0];return res.json({ok:true,model:"governed_automation_engine_v1",human_approval_required:true,direct_external_execution:false,p17_promotion_required:true,counts});}catch(error:any){return res.status(500).json({ok:false,error:error?.message||"p18_status_failed"});}});

router.get("/proposals",async(req:AuthRequest,res:Response)=>{const tenant=tenantId(req,res);if(!tenant)return;try{const status=String(req.query.status||"").trim();const rows=(await pool.query(`SELECT * FROM vir_p18_proposals WHERE tenant_id=$1::bigint AND ($2::text='' OR status=$2::text) ORDER BY CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,created_at DESC LIMIT 250`,[tenant,status])).rows;return res.json({ok:true,items:rows});}catch(error:any){return res.status(500).json({ok:false,error:error?.message||"p18_proposals_failed"});}});

router.post("/generate",async(req:AuthRequest,res:Response)=>{
  const tenant=tenantId(req,res);if(!tenant)return;const location=await validateLocation(req.body?.locationId,tenant,res);if(location===undefined)return;const actor=actorId(req);const today=new Date().toISOString().slice(0,10);
  try{
    const p16=await safeQuery(`SELECT id,title,area,priority,reason,evidence,recommended_action FROM vir_p16_decisions WHERE tenant_id::text=$1 AND status='open' ORDER BY created_at DESC LIMIT 50`,[tenant]);
    const stats=(await safeQuery(`SELECT COUNT(*) FILTER(WHERE start_time>=now() AND start_time<now()+interval '7 days' AND status NOT IN ('cancelled','no_show'))::int future_bookings_7d,COUNT(DISTINCT employee_id) FILTER(WHERE start_time>=now() AND start_time<now()+interval '7 days' AND status NOT IN ('cancelled','no_show'))::int booked_staff_7d,COUNT(*) FILTER(WHERE start_time>=now()-interval '30 days' AND status='no_show')::int no_shows_30d FROM appointments WHERE tenant_id::text=$1 AND ($2::uuid IS NULL OR location_id=$2::uuid)`,[tenant,location]))[0]||{future_bookings_7d:0,booked_staff_7d:0,no_shows_30d:0};
    const p17=(await safeQuery(`SELECT COUNT(*) FILTER(WHERE status='pending_approval')::int pending_approval FROM vir_p17_operations WHERE tenant_id=$1::bigint`,[tenant]))[0]||{pending_approval:0};
    const proposals:any[]=[];
    for(const d of p16){const priority=String(d.priority||"medium").toLowerCase();proposals.push({key:`p16:${d.id}`,source:"p16_decision",operation_type:operationForArea(d.area,d.recommended_action),title:String(d.title||"Vezetői intézkedési javaslat"),reason:String(d.reason||"P16 vezetői jelzés"),priority:["low","medium","high","critical"].includes(priority)?priority:"medium",confidence:0.82,evidence:{decision_id:d.id,area:d.area,evidence:d.evidence,recommended_action:d.recommended_action}});}
    const bookings=Number(stats.future_bookings_7d||0),staff=Number(stats.booked_staff_7d||0),noShows=Number(stats.no_shows_30d||0),pending=Number(p17.pending_approval||0);
    if(bookings>Math.max(1,staff)*8)proposals.push({key:`capacity:${today}:${location||"all"}`,source:"operational_signal",operation_type:"staffing_review",title:"Kapacitásátrendezés felülvizsgálata",reason:`${bookings} foglalás jut ${staff} aktívan foglalt munkatársra a következő 7 napban.`,priority:"high",confidence:0.76,evidence:{future_bookings_7d:bookings,booked_staff_7d:staff}});
    if(noShows>=5)proposals.push({key:`noshow:${today}:${location||"all"}`,source:"revenue_signal",operation_type:"revenue_review",title:"No-show bevételvédelmi intézkedés",reason:`${noShows} no-show történt az elmúlt 30 napban.`,priority:noShows>=12?"critical":"high",confidence:Math.min(0.95,0.65+noShows/100),evidence:{no_shows_30d:noShows}});
    if(pending>=6)proposals.push({key:`approval-backlog:${today}`,source:"governance_signal",operation_type:"manual_task",title:"Jóváhagyási torlódás felszámolása",reason:`${pending} P17 művelet vár vezetői jóváhagyásra.`,priority:pending>=12?"high":"medium",confidence:0.9,evidence:{pending_approval:pending}});
    let created=0;
    for(const p of proposals){const q=await pool.query(`INSERT INTO vir_p18_proposals(tenant_id,location_id,proposal_key,source_type,operation_type,title,reason,priority,confidence,evidence,created_by) VALUES($1::bigint,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) ON CONFLICT(tenant_id,proposal_key) WHERE status='proposed' DO NOTHING`,[tenant,location,p.key,p.source,p.operation_type,p.title,p.reason,p.priority,p.confidence,JSON.stringify(p.evidence),actor]);created+=q.rowCount||0;}
    return res.json({ok:true,model:"governed_automation_engine_v1",generated:proposals.length,created,human_approval_required:true,direct_external_execution:false,signals:{...stats,p17_pending_approval:pending}});
  }catch(error:any){return res.status(500).json({ok:false,error:error?.message||"p18_generate_failed"});}
});

router.post("/proposals/:id/promote",async(req:AuthRequest,res:Response)=>{
  const tenant=tenantId(req,res);if(!tenant)return;const id=String(req.params.id||"");if(!UUID.test(id))return res.status(400).json({ok:false,error:"invalid_proposal_id"});const actor=actorId(req),client=await pool.connect();
  try{await client.query("BEGIN");const proposal=(await client.query(`SELECT * FROM vir_p18_proposals WHERE id=$1::uuid AND tenant_id=$2::bigint FOR UPDATE`,[id,tenant])).rows[0];if(!proposal){await client.query("ROLLBACK");return res.status(404).json({ok:false,error:"proposal_not_found"});}if(proposal.status!=="proposed"){await client.query("ROLLBACK");return res.status(409).json({ok:false,error:"proposal_already_decided",status:proposal.status});}
    const operation=(await client.query(`INSERT INTO vir_p17_operations(tenant_id,location_id,operation_type,title,status,execution_mode,approval_required,risk_level,source_layer,source_ref,idempotency_key,preview_payload,created_by) VALUES($1::bigint,$2::uuid,$3,$4,'pending_approval','controlled_manual',true,$5,'p18',$6,$7,$8::jsonb,$9) ON CONFLICT(tenant_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE SET updated_at=now() RETURNING *`,[tenant,proposal.location_id,proposal.operation_type,proposal.title,priorityToRisk(proposal.priority),String(proposal.id),`p18:${proposal.id}`,JSON.stringify({reason:proposal.reason,confidence:proposal.confidence,evidence:proposal.evidence}),actor])).rows[0];
    await client.query(`UPDATE vir_p18_proposals SET status='promoted',promoted_operation_id=$3::uuid,decided_by=$4,decided_at=now(),updated_at=now() WHERE id=$1::uuid AND tenant_id=$2::bigint`,[id,tenant,operation.id,actor]);
    await client.query(`INSERT INTO vir_p17_operation_events(tenant_id,operation_id,event_type,actor_id,payload) VALUES($1::bigint,$2::uuid,'promoted_from_p18',$3,$4::jsonb)`,[tenant,operation.id,actor,JSON.stringify({proposal_id:id,confidence:proposal.confidence})]);
    await client.query("COMMIT");return res.json({ok:true,proposal_id:id,operation,human_approval_required:true,direct_external_execution:false});
  }catch(error:any){await client.query("ROLLBACK").catch(()=>undefined);return res.status(500).json({ok:false,error:error?.message||"p18_promote_failed"});}finally{client.release();}
});

router.post("/proposals/:id/dismiss",async(req:AuthRequest,res:Response)=>{const tenant=tenantId(req,res);if(!tenant)return;const id=String(req.params.id||"");if(!UUID.test(id))return res.status(400).json({ok:false,error:"invalid_proposal_id"});try{const row=(await pool.query(`UPDATE vir_p18_proposals SET status='dismissed',decided_by=$3,decided_at=now(),updated_at=now() WHERE id=$1::uuid AND tenant_id=$2::bigint AND status='proposed' RETURNING *`,[id,tenant,actorId(req)])).rows[0];if(!row)return res.status(404).json({ok:false,error:"proposal_not_found_or_decided"});return res.json({ok:true,item:row});}catch(error:any){return res.status(500).json({ok:false,error:error?.message||"p18_dismiss_failed"});}});

export default router;
