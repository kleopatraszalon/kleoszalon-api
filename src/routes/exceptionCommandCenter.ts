import { Router } from "express";
import { AuthRequest } from "../middleware/auth";
import {
  addExceptionComment,
  bulkExceptionAction,
  ensureExceptionCommandCenterSchema,
  exceptionCenterSummary,
  exportExceptionCasesCsv,
  getExceptionCase,
  listExceptionCases,
  listExceptionRoutingRules,
  startExceptionCommandCenterScheduler,
  syncExceptionCommandCenter,
  updateExceptionCase,
  updateExceptionRoutingRule,
} from "../services/exceptionCommandCenter";
import { reconcileExceptionCommandCenterConsistency } from "../services/exceptionCommandCenterConsistency";
import {
  ensureExceptionIntelligenceSchema,
  getExceptionIntelligenceDashboard,
  listExceptionEscalationRules,
  runExceptionIntelligenceCycle,
  sendExceptionExecutiveBrief,
  startExceptionCommandCenterIntelligenceScheduler,
  updateExceptionEscalationRule,
} from "../services/exceptionCommandCenterIntelligence";
import {
  ensureExceptionCapaSchema,
  exceptionCapaSummary,
  getExceptionCapa,
  listExceptionCapas,
  startExceptionCapaScheduler,
  syncExceptionCapaCandidates,
  updateExceptionCapa,
} from "../services/exceptionCapa";
import { ensureExceptionCapaHardeningSchema } from "../services/exceptionCapaHardening";
import {
  ensureExceptionCapaImprovementBridge,
  getExceptionCapaImprovementLink,
  promoteExceptionCapaToImprovement,
} from "../services/exceptionCapaImprovement";
import {
  addMajorIncidentAction,
  addMajorIncidentUpdate,
  ensureMajorIncidentSchema,
  getMajorIncident,
  listMajorIncidents,
  majorIncidentSummary,
  startMajorIncidentWarRoomScheduler,
  syncMajorIncidentWarRooms,
  updateMajorIncident,
  updateMajorIncidentAction,
} from "../services/majorIncidentWarRoom";
import { ensureMajorIncidentHardeningSchema } from "../services/majorIncidentWarRoomHardening";
import { runMajorIncidentWarRoomWatchdog, startMajorIncidentWarRoomWatchdog } from "../services/majorIncidentWarRoomWatchdog";
import {
  declareRecoveryAllClear,
  decideEmergencyChangeOverride,
  ensureResilienceRecoverySchema,
  getRecoverySession,
  listRecoverySessions,
  listResilienceServiceProfiles,
  requestEmergencyChangeOverride,
  resilienceRecoverySummary,
  startResilienceRecoveryScheduler,
  syncResilienceRecoveryControl,
  updateRecoveryServiceState,
  updateRecoveryStep,
  updateResilienceServiceProfile,
} from "../services/resilienceRecoveryControl";
import { locationBelongsToTenant, resolveTenantIdentity } from "../saas/tenantAccess";

const router=Router();
startExceptionCommandCenterScheduler();
startExceptionCommandCenterIntelligenceScheduler();
startExceptionCapaScheduler();
startMajorIncidentWarRoomScheduler();
startMajorIncidentWarRoomWatchdog();
startResilienceRecoveryScheduler();
void ensureExceptionCommandCenterSchema().catch(error=>console.error("[exception-center] startup schema bootstrap failed",error));
void ensureExceptionIntelligenceSchema().catch(error=>console.error("[exception-intelligence] startup schema bootstrap failed",error));
void ensureExceptionCapaSchema().catch(error=>console.error("[exception-capa] startup schema bootstrap failed",error));
void ensureExceptionCapaHardeningSchema().catch(error=>console.error("[exception-capa] state guard bootstrap failed",error));
void ensureExceptionCapaImprovementBridge().catch(error=>console.error("[exception-capa] improvement bridge bootstrap failed",error));
void ensureMajorIncidentSchema().catch(error=>console.error("[major-incident] startup schema bootstrap failed",error));
void ensureMajorIncidentHardeningSchema().catch(error=>console.error("[major-incident] state guard bootstrap failed",error));
void ensureResilienceRecoverySchema().catch(error=>console.error("[resilience] schema bootstrap failed",error));

const actor=(req:AuthRequest)=>String(req.user?.email||req.user?.id||"management-user");
const actorId=(req:AuthRequest)=>String(req.user?.id||"").trim()||null;
const requestIp=(req:AuthRequest)=>String(req.ip||req.socket?.remoteAddress||"").trim()||null;
const loc=(req:AuthRequest)=>String(req.query.location_id||req.user?.location_id||"").trim()||null;
const sendError=(error:any,res:any,next:any)=>error?.status?res.status(error.status).json({message:error.message}):next(error);
const sendGovernanceError=(error:any,res:any,next:any)=>String(error?.code||"")==="23514"?res.status(409).json({message:error?.message||"A governance szabály megakadályozta a műveletet.",code:"capa_governance_conflict"}):sendError(error,res,next);
const sendMajorIncidentGovernanceError=(error:any,res:any,next:any)=>String(error?.code||"")==="23514"?res.status(409).json({message:error?.message||"A Major Incident governance szabály megakadályozta a műveletet.",code:"major_incident_governance_conflict"}):sendError(error,res,next);
const sendResilienceGovernanceError=(error:any,res:any,next:any)=>String(error?.code||"")==="23514"?res.status(409).json({message:error?.message||"A Resilience governance szabály megakadályozta a műveletet.",code:"resilience_governance_conflict"}):sendError(error,res,next);
const capaVisible=(detail:any,location:string|null)=>!location||!detail?.item?.location_id||String(detail.item.location_id)===location;
const incidentVisible=(detail:any,location:string|null)=>!location||!detail?.item?.location_id||String(detail.item.location_id)===location;
const recoveryVisible=(detail:any,location:string|null)=>!location||!detail?.item?.location_id||String(detail.item.location_id)===location;
const tenantId=async(req:AuthRequest)=>{const tenant=await resolveTenantIdentity(req);if(!tenant)throw Object.assign(new Error("A tenant nem azonosítható."),{status:403});return String(tenant.id)};

router.use(async(_req,_res,next)=>{try{await ensureExceptionCommandCenterSchema();await ensureExceptionCapaHardeningSchema();await ensureExceptionCapaImprovementBridge();await ensureMajorIncidentHardeningSchema();await ensureResilienceRecoverySchema();next()}catch(error){next(error)}});

router.get("/summary",async(req:AuthRequest,res,next)=>{try{res.json(await exceptionCenterSummary(loc(req)))}catch(error){next(error)}});
router.get("/cases",async(req:AuthRequest,res,next)=>{try{res.json({items:await listExceptionCases({...req.query,location_id:loc(req)})})}catch(error){next(error)}});
router.get("/cases/:id",async(req:AuthRequest,res,next)=>{try{res.json(await getExceptionCase(String(req.params.id)))}catch(error:any){sendError(error,res,next)}});
router.patch("/cases/:id",async(req:AuthRequest,res,next)=>{try{res.json(await updateExceptionCase(String(req.params.id),req.body||{},actor(req)))}catch(error:any){sendError(error,res,next)}});
router.post("/cases/:id/comment",async(req:AuthRequest,res,next)=>{try{res.json(await addExceptionComment(String(req.params.id),String(req.body?.message||""),actor(req)))}catch(error:any){sendError(error,res,next)}});
router.post("/cases/bulk",async(req:AuthRequest,res,next)=>{try{res.json(await bulkExceptionAction(Array.isArray(req.body?.ids)?req.body.ids:[],req.body||{},actor(req)))}catch(error:any){sendError(error,res,next)}});
router.post("/sync",async(_req:AuthRequest,res,next)=>{try{const sync=await syncExceptionCommandCenter();const consistency=await reconcileExceptionCommandCenterConsistency();const intelligence=await runExceptionIntelligenceCycle();const capa=await syncExceptionCapaCandidates();const incidents=await syncMajorIncidentWarRooms();const resilience=await syncResilienceRecoveryControl();res.json({...sync,consistency,intelligence,capa,incidents,resilience})}catch(error){next(error)}});
router.post("/consistency",async(_req:AuthRequest,res,next)=>{try{res.json(await reconcileExceptionCommandCenterConsistency())}catch(error){next(error)}});
router.get("/routing-rules",async(_req:AuthRequest,res,next)=>{try{res.json({items:await listExceptionRoutingRules()})}catch(error){next(error)}});
router.put("/routing-rules/:category",async(req:AuthRequest,res,next)=>{try{res.json(await updateExceptionRoutingRule(String(req.params.category),req.body||{},actor(req)))}catch(error:any){sendError(error,res,next)}});

router.get("/intelligence/dashboard",async(req:AuthRequest,res,next)=>{try{res.json(await getExceptionIntelligenceDashboard(Number(req.query.days||30),loc(req)))}catch(error){next(error)}});
router.post("/intelligence/run",async(_req:AuthRequest,res,next)=>{try{const intelligence=await runExceptionIntelligenceCycle();const capa=await syncExceptionCapaCandidates();const incidents=await syncMajorIncidentWarRooms();const resilience=await syncResilienceRecoveryControl();res.json({...intelligence,capa,incidents,resilience})}catch(error){next(error)}});
router.get("/intelligence/escalation-rules",async(_req:AuthRequest,res,next)=>{try{res.json({items:await listExceptionEscalationRules()})}catch(error){next(error)}});
router.put("/intelligence/escalation-rules/:severity",async(req:AuthRequest,res,next)=>{try{res.json(await updateExceptionEscalationRule(String(req.params.severity),req.body||{},actor(req)))}catch(error:any){sendError(error,res,next)}});
router.post("/intelligence/brief/:type",async(req:AuthRequest,res,next)=>{try{const type=String(req.params.type);if(type!=="morning"&&type!=="evening")return res.status(400).json({message:"A brief típusa morning vagy evening lehet."});res.json(await sendExceptionExecutiveBrief(type))}catch(error){next(error)}});

router.get("/intelligence/resilience/summary",async(req:AuthRequest,res,next)=>{try{res.json(await resilienceRecoverySummary(loc(req)))}catch(error){next(error)}});
router.get("/intelligence/resilience/sessions",async(req:AuthRequest,res,next)=>{try{res.json({items:await listRecoverySessions({...req.query,location_id:loc(req)})})}catch(error){next(error)}});
router.post("/intelligence/resilience/sync",async(_req:AuthRequest,res,next)=>{try{res.json(await syncResilienceRecoveryControl())}catch(error){next(error)}});
router.get("/intelligence/resilience/services",async(_req:AuthRequest,res,next)=>{try{res.json({items:await listResilienceServiceProfiles()})}catch(error){next(error)}});
router.put("/intelligence/resilience/services/:serviceKey",async(req:AuthRequest,res,next)=>{try{res.json(await updateResilienceServiceProfile(String(req.params.serviceKey),req.body||{},actor(req)))}catch(error:any){sendResilienceGovernanceError(error,res,next)}});
router.get("/intelligence/resilience/sessions/:id",async(req:AuthRequest,res,next)=>{try{const detail=await getRecoverySession(String(req.params.id));if(!recoveryVisible(detail,loc(req)))return res.status(404).json({message:"A recovery session nem található ebben a telephelyi hatókörben."});res.json(detail)}catch(error:any){sendError(error,res,next)}});
router.patch("/intelligence/resilience/sessions/:id/services/:serviceKey",async(req:AuthRequest,res,next)=>{try{const detail=await getRecoverySession(String(req.params.id));if(!recoveryVisible(detail,loc(req)))return res.status(404).json({message:"A recovery session nem található ebben a telephelyi hatókörben."});res.json(await updateRecoveryServiceState(String(req.params.id),String(req.params.serviceKey),req.body||{},actor(req)))}catch(error:any){sendResilienceGovernanceError(error,res,next)}});
router.patch("/intelligence/resilience/sessions/:id/steps/:serviceKey/:stepKey",async(req:AuthRequest,res,next)=>{try{const detail=await getRecoverySession(String(req.params.id));if(!recoveryVisible(detail,loc(req)))return res.status(404).json({message:"A recovery session nem található ebben a telephelyi hatókörben."});res.json(await updateRecoveryStep(String(req.params.id),String(req.params.serviceKey),String(req.params.stepKey),req.body||{},actor(req)))}catch(error:any){sendResilienceGovernanceError(error,res,next)}});
router.post("/intelligence/resilience/sessions/:id/all-clear",async(req:AuthRequest,res,next)=>{try{const detail=await getRecoverySession(String(req.params.id));if(!recoveryVisible(detail,loc(req)))return res.status(404).json({message:"A recovery session nem található ebben a telephelyi hatókörben."});res.json(await declareRecoveryAllClear(String(req.params.id),req.body||{},actor(req)))}catch(error:any){sendResilienceGovernanceError(error,res,next)}});
router.post("/intelligence/resilience/freezes/:freezeId/overrides",async(req:AuthRequest,res,next)=>{try{res.json(await requestEmergencyChangeOverride(String(req.params.freezeId),req.body||{},actor(req)))}catch(error:any){sendResilienceGovernanceError(error,res,next)}});
router.post("/intelligence/resilience/freezes/:freezeId/overrides/:overrideId/decision",async(req:AuthRequest,res,next)=>{try{res.json(await decideEmergencyChangeOverride(String(req.params.freezeId),String(req.params.overrideId),req.body||{},actor(req)))}catch(error:any){sendResilienceGovernanceError(error,res,next)}});

router.get("/intelligence/major-incidents/summary",async(req:AuthRequest,res,next)=>{try{res.json(await majorIncidentSummary(loc(req)))}catch(error){next(error)}});
router.get("/intelligence/major-incidents",async(req:AuthRequest,res,next)=>{try{res.json({items:await listMajorIncidents({...req.query,location_id:loc(req)})})}catch(error){next(error)}});
router.post("/intelligence/major-incidents/sync",async(_req:AuthRequest,res,next)=>{try{const incidents=await syncMajorIncidentWarRooms();const resilience=await syncResilienceRecoveryControl();res.json({...incidents,resilience})}catch(error){next(error)}});
router.post("/intelligence/major-incidents/watchdog",async(_req:AuthRequest,res,next)=>{try{res.json(await runMajorIncidentWarRoomWatchdog())}catch(error){next(error)}});
router.get("/intelligence/major-incidents/:id",async(req:AuthRequest,res,next)=>{try{const detail=await getMajorIncident(String(req.params.id));if(!incidentVisible(detail,loc(req)))return res.status(404).json({message:"A Major Incident nem található ebben a telephelyi hatókörben."});res.json(detail)}catch(error:any){sendError(error,res,next)}});
router.patch("/intelligence/major-incidents/:id",async(req:AuthRequest,res,next)=>{try{const detail=await getMajorIncident(String(req.params.id));if(!incidentVisible(detail,loc(req)))return res.status(404).json({message:"A Major Incident nem található ebben a telephelyi hatókörben."});res.json(await updateMajorIncident(String(req.params.id),req.body||{},actor(req)))}catch(error:any){sendMajorIncidentGovernanceError(error,res,next)}});
router.post("/intelligence/major-incidents/:id/actions",async(req:AuthRequest,res,next)=>{try{const detail=await getMajorIncident(String(req.params.id));if(!incidentVisible(detail,loc(req)))return res.status(404).json({message:"A Major Incident nem található ebben a telephelyi hatókörben."});res.json(await addMajorIncidentAction(String(req.params.id),req.body||{},actor(req)))}catch(error:any){sendMajorIncidentGovernanceError(error,res,next)}});
router.patch("/intelligence/major-incidents/:id/actions/:actionId",async(req:AuthRequest,res,next)=>{try{const detail=await getMajorIncident(String(req.params.id));if(!incidentVisible(detail,loc(req)))return res.status(404).json({message:"A Major Incident nem található ebben a telephelyi hatókörben."});res.json(await updateMajorIncidentAction(String(req.params.id),String(req.params.actionId),req.body||{},actor(req)))}catch(error:any){sendMajorIncidentGovernanceError(error,res,next)}});
router.post("/intelligence/major-incidents/:id/updates",async(req:AuthRequest,res,next)=>{try{const detail=await getMajorIncident(String(req.params.id));if(!incidentVisible(detail,loc(req)))return res.status(404).json({message:"A Major Incident nem található ebben a telephelyi hatókörben."});res.json(await addMajorIncidentUpdate(String(req.params.id),req.body||{},actor(req)))}catch(error:any){sendMajorIncidentGovernanceError(error,res,next)}});

router.get("/intelligence/capa/summary",async(req:AuthRequest,res,next)=>{try{res.json(await exceptionCapaSummary(loc(req)))}catch(error){next(error)}});
router.get("/intelligence/capa",async(req:AuthRequest,res,next)=>{try{const location=loc(req);const rows=await listExceptionCapas({...req.query,location_id:null});const items=location?rows.filter((x:any)=>!x.location_id||String(x.location_id)===location):rows;res.json({items})}catch(error){next(error)}});
router.post("/intelligence/capa/sync",async(_req:AuthRequest,res,next)=>{try{res.json(await syncExceptionCapaCandidates())}catch(error){next(error)}});
router.get("/intelligence/capa/:id",async(req:AuthRequest,res,next)=>{try{const detail=await getExceptionCapa(String(req.params.id));if(!capaVisible(detail,loc(req)))return res.status(404).json({message:"A CAPA rekord nem található ebben a telephelyi hatókörben."});const tenant=await tenantId(req);const improvement_link=await getExceptionCapaImprovementLink(String(req.params.id),tenant);res.json({...detail,improvement_link})}catch(error:any){sendError(error,res,next)}});
router.patch("/intelligence/capa/:id",async(req:AuthRequest,res,next)=>{try{const detail=await getExceptionCapa(String(req.params.id));if(!capaVisible(detail,loc(req)))return res.status(404).json({message:"A CAPA rekord nem található ebben a telephelyi hatókörben."});res.json(await updateExceptionCapa(String(req.params.id),req.body||{},actor(req)))}catch(error:any){sendGovernanceError(error,res,next)}});
router.post("/intelligence/capa/:id/promote",async(req:AuthRequest,res,next)=>{try{
  const capaId=String(req.params.id);const detail=await getExceptionCapa(capaId);const scope=loc(req);
  if(!capaVisible(detail,scope))return res.status(404).json({message:"A CAPA rekord nem található ebben a telephelyi hatókörben."});
  const tenant=await tenantId(req);const sourceLocation=String(detail?.item?.location_id||"").trim()||null;const requestedLocation=String(req.body?.location_id||sourceLocation||scope||"").trim()||null;
  if(sourceLocation&&!(await locationBelongsToTenant(sourceLocation,tenant)))return res.status(404).json({message:"A CAPA forrás-telephelye nem érhető el ebben a vállalatban."});
  if(requestedLocation&&!(await locationBelongsToTenant(requestedLocation,tenant)))return res.status(403).json({message:"A kiválasztott projekt-telephely nem tartozik ehhez a vállalathoz."});
  const result=await promoteExceptionCapaToImprovement({capaId,tenantId:tenant,actor:actor(req),actorUserId:actorId(req),requestIp:requestIp(req),locationId:requestedLocation});
  res.status(result.created?201:200).json(result);
}catch(error:any){sendGovernanceError(error,res,next)}});

router.get("/export.csv",async(req:AuthRequest,res,next)=>{try{const csv=await exportExceptionCasesCsv({...req.query,location_id:loc(req)});res.setHeader("Content-Type","text/csv; charset=utf-8");res.setHeader("Content-Disposition",`attachment; filename="kleo-exception-center-${new Date().toISOString().slice(0,10)}.csv"`);res.send(csv)}catch(error){next(error)}});

export default router;