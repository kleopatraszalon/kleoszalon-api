import { Router, Response } from "express";
import pool from "../db";
import type { AuthRequest } from "../middleware/auth";
import { requireManagement } from "../middleware/requireRoles";
import { locationBelongsToTenant } from "../saas/tenantAccess";

const router = Router();
router.use(requireManagement);

const OPERATION_TYPES = new Set(["capacity_review","staffing_review","inventory_review","revenue_review","manual_task"]);
const STATUSES = new Set(["pending_approval","approved","executed","verified","rolled_back","rejected"]);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function tenantId(req:AuthRequest,res:Response):string|undefined{
  const value=String(req.user?.tenant_id??"").trim();
  if(!/^\d+$/.test(value)||Number(value)<=0){res.status(403).json({ok:false,error:"tenant_context_required"});return;}
  return value;
}
function actorId(req:AuthRequest):string{return String(req.user?.id??req.user?.employee_id??"system");}
function cleanObject(value:unknown):Record<string,unknown>{return value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{};}
function riskFor(type:string):"low"|"medium"|"high"{if(type==="manual_task")return "low";if(type==="staffing_review"||type==="revenue_review")return "high";return "medium";}
async function validateLocation(locationId:unknown,tenant:string,res:Response):Promise<string|null|undefined>{
  const value=String(locationId??"").trim();
  if(!value)return null;
  if(!UUID.test(value)){res.status(400).json({ok:false,error:"invalid_location_id"});return;}
  if(!(await locationBelongsToTenant(value,tenant))){res.status(403).json({ok:false,error:"tenant_location_mismatch"});return;}
  return value;
}
async function appendEvent(client:any,tenant:string,operationId:string,eventType:string,actor:string,payload:Record<string,unknown>){
  await client.query(`INSERT INTO vir_p17_operation_events(tenant_id,operation_id,event_type,actor_id,payload) VALUES($1::bigint,$2::uuid,$3,$4,$5::jsonb)`,[tenant,operationId,eventType,actor,JSON.stringify(payload)]);
}

type TransitionOptions={from:string[];to:string;actorColumn:string;timeColumn:string;payloadColumn:string;eventType:string};
async function transition(req:AuthRequest,res:Response,options:TransitionOptions){
  const tenant=tenantId(req,res);if(!tenant)return;
  const operationId=String(req.params.id||"").trim();if(!UUID.test(operationId))return res.status(400).json({ok:false,error:"invalid_operation_id"});
  const payload=cleanObject(req.body?.payload??req.body),actor=actorId(req),client=await pool.connect();
  try{
    await client.query("BEGIN");
    const current=(await client.query(`SELECT * FROM vir_p17_operations WHERE id=$1::uuid AND tenant_id=$2::bigint FOR UPDATE`,[operationId,tenant])).rows[0];
    if(!current){await client.query("ROLLBACK");return res.status(404).json({ok:false,error:"operation_not_found"});}
    if(!options.from.includes(String(current.status))){await client.query("ROLLBACK");return res.status(409).json({ok:false,error:"invalid_state_transition",current_status:current.status,allowed_from:options.from,target_status:options.to});}
    const sql=`UPDATE vir_p17_operations SET status=$3,${options.actorColumn}=$4,${options.timeColumn}=now(),${options.payloadColumn}=$5::jsonb,updated_at=now() WHERE id=$1::uuid AND tenant_id=$2::bigint RETURNING *`;
    const updated=(await client.query(sql,[operationId,tenant,options.to,actor,JSON.stringify(payload)])).rows[0];
    await appendEvent(client,tenant,operationId,options.eventType,actor,{from:current.status,to:options.to,...payload});
    await client.query("COMMIT");return res.json({ok:true,operation:updated});
  }catch(error:any){await client.query("ROLLBACK").catch(()=>undefined);return res.status(500).json({ok:false,error:error?.message||"p17_transition_failed"});}
  finally{client.release();}
}

router.get("/status",async(req:AuthRequest,res:Response)=>{
  const tenant=tenantId(req,res);if(!tenant)return;
  try{const summary=(await pool.query(`SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE status='pending_approval')::int pending_approval,COUNT(*) FILTER(WHERE status='approved')::int approved,COUNT(*) FILTER(WHERE status='executed')::int executed,COUNT(*) FILTER(WHERE status='verified')::int verified,COUNT(*) FILTER(WHERE status='rolled_back')::int rolled_back FROM vir_p17_operations WHERE tenant_id=$1::bigint`,[tenant])).rows[0];return res.json({ok:true,model:"autonomous_operations_control_v1",tenant_id:tenant,external_side_effects:false,workflow:["preview","approval","execute","verify","rollback"],summary});}
  catch(error:any){return res.status(500).json({ok:false,error:error?.message||"p17_status_failed"});}
});

router.get("/operations",async(req:AuthRequest,res:Response)=>{
  const tenant=tenantId(req,res);if(!tenant)return;
  try{const status=String(req.query.status||"").trim();if(status&&!STATUSES.has(status))return res.status(400).json({ok:false,error:"invalid_status"});const location=await validateLocation(req.query.locationId,tenant,res);if(location===undefined)return;const rows=(await pool.query(`SELECT * FROM vir_p17_operations WHERE tenant_id=$1::bigint AND ($2::text='' OR status=$2::text) AND ($3::uuid IS NULL OR location_id=$3::uuid) ORDER BY created_at DESC LIMIT 250`,[tenant,status,location])).rows;return res.json({ok:true,items:rows});}
  catch(error:any){return res.status(500).json({ok:false,error:error?.message||"p17_operations_failed"});}
});

router.post("/preview",async(req:AuthRequest,res:Response)=>{
  const tenant=tenantId(req,res);if(!tenant)return;
  try{const operationType=String(req.body?.operation_type||"").trim().toLowerCase();if(!OPERATION_TYPES.has(operationType))return res.status(400).json({ok:false,error:"unsupported_operation_type",allowed:[...OPERATION_TYPES]});const location=await validateLocation(req.body?.locationId,tenant,res);if(location===undefined)return;const title=String(req.body?.title||operationType).trim().slice(0,180),risk=riskFor(operationType);return res.json({ok:true,model:"p17_operation_preview_v1",preview:{operation_type:operationType,title,tenant_id:tenant,location_id:location,risk_level:risk,approval_required:true,execution_mode:"controlled_manual",external_side_effects:false,guardrails:["tenant_scope_locked","explicit_approval_required","audit_event_required","verification_required","rollback_supported"]}});}
  catch(error:any){return res.status(500).json({ok:false,error:error?.message||"p17_preview_failed"});}
});

router.post("/operations",async(req:AuthRequest,res:Response)=>{
  const tenant=tenantId(req,res);if(!tenant)return;
  try{const operationType=String(req.body?.operation_type||"").trim().toLowerCase();if(!OPERATION_TYPES.has(operationType))return res.status(400).json({ok:false,error:"unsupported_operation_type",allowed:[...OPERATION_TYPES]});const location=await validateLocation(req.body?.locationId,tenant,res);if(location===undefined)return;const title=String(req.body?.title||operationType).trim().slice(0,180);if(!title)return res.status(400).json({ok:false,error:"title_required"});const idempotencyKey=String(req.body?.idempotency_key||"").trim().slice(0,160)||null;if(idempotencyKey){const existing=(await pool.query(`SELECT * FROM vir_p17_operations WHERE tenant_id=$1::bigint AND idempotency_key=$2 LIMIT 1`,[tenant,idempotencyKey])).rows[0];if(existing)return res.json({ok:true,idempotent_replay:true,operation:existing});}const preview=cleanObject(req.body?.preview_payload),actor=actorId(req),risk=riskFor(operationType),client=await pool.connect();try{await client.query("BEGIN");const operation=(await client.query(`INSERT INTO vir_p17_operations(tenant_id,location_id,operation_type,title,status,execution_mode,approval_required,risk_level,idempotency_key,preview_payload,created_by) VALUES($1::bigint,$2::uuid,$3,$4,'pending_approval','controlled_manual',true,$5,$6,$7::jsonb,$8) RETURNING *`,[tenant,location,operationType,title,risk,idempotencyKey,JSON.stringify(preview),actor])).rows[0];await appendEvent(client,tenant,String(operation.id),"created",actor,{operation_type:operationType,risk_level:risk});await client.query("COMMIT");return res.status(201).json({ok:true,operation});}catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release();}}
  catch(error:any){return res.status(500).json({ok:false,error:error?.message||"p17_create_failed"});}
});

router.post("/operations/:id/approve",(req:AuthRequest,res:Response)=>transition(req,res,{from:["pending_approval"],to:"approved",actorColumn:"approved_by",timeColumn:"approved_at",payloadColumn:"approval_payload",eventType:"approved"}));
router.post("/operations/:id/execute",(req:AuthRequest,res:Response)=>transition(req,res,{from:["approved"],to:"executed",actorColumn:"executed_by",timeColumn:"executed_at",payloadColumn:"execution_payload",eventType:"executed"}));
router.post("/operations/:id/verify",(req:AuthRequest,res:Response)=>transition(req,res,{from:["executed"],to:"verified",actorColumn:"verified_by",timeColumn:"verified_at",payloadColumn:"verification_payload",eventType:"verified"}));
router.post("/operations/:id/rollback",(req:AuthRequest,res:Response)=>transition(req,res,{from:["executed","verified"],to:"rolled_back",actorColumn:"rolled_back_by",timeColumn:"rolled_back_at",payloadColumn:"rollback_payload",eventType:"rolled_back"}));

export default router;
