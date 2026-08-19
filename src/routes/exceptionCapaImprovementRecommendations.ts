import {Router} from "express";
import {AuthRequest} from "../middleware/auth";
import {getExceptionCapa} from "../services/exceptionCapa";
import {
  dismissExceptionCapaImprovementRecommendation,
  ensureExceptionCapaImprovementRecommendationSchema,
  getExceptionCapaImprovementRecommendation,
  refreshExceptionCapaImprovementRecommendation,
  startExceptionCapaImprovementRecommendationScheduler,
} from "../services/exceptionCapaImprovementRecommendation";
import {
  acknowledgeExceptionCapaManagementAssignment,
  assignExceptionCapaManagementOwner,
  ensureExceptionCapaManagementQueueSchema,
  getExceptionCapaManagementQueueSummary,
  listExceptionCapaManagementQueue,
} from "../services/exceptionCapaManagementQueue";
import {locationBelongsToTenant,resolveTenantIdentity,tenantLocationIds} from "../saas/tenantAccess";

const router=Router();
startExceptionCapaImprovementRecommendationScheduler();
void ensureExceptionCapaImprovementRecommendationSchema().catch(error=>console.error('[exception-capa] improvement recommendation schema bootstrap failed',error));
void ensureExceptionCapaManagementQueueSchema().catch(error=>console.error('[exception-capa] management workqueue schema bootstrap failed',error));

const actor=(req:AuthRequest)=>String(req.user?.email||req.user?.id||'management-user');
const loc=(req:AuthRequest)=>String(req.query.location_id||req.body?.location_id||req.user?.location_id||'').trim()||null;
const sendError=(error:any,res:any,next:any)=>error?.status?res.status(error.status).json({message:error.message}):String(error?.code||'')==='23514'?res.status(409).json({message:error?.message||'A governance szabály megakadályozta a műveletet.',code:'improvement_recommendation_governance_conflict'}):next(error);
const tenantId=async(req:AuthRequest)=>{const tenant=await resolveTenantIdentity(req);if(!tenant)throw Object.assign(new Error('A tenant nem azonosítható.'),{status:403});return String(tenant.id)};

async function scope(req:AuthRequest){
  const capa=await getExceptionCapa(String(req.params.id));
  const tenant=await tenantId(req);
  const sourceLocation=String(capa?.item?.location_id||'').trim()||null;
  const requested=loc(req);
  if(requested&&sourceLocation&&requested!==sourceLocation)throw Object.assign(new Error('A CAPA rekord nem található ebben a telephelyi hatókörben.'),{status:404});
  if(sourceLocation&&!(await locationBelongsToTenant(sourceLocation,tenant)))throw Object.assign(new Error('A CAPA rekord nem érhető el ebben a vállalatban.'),{status:404});
  if(requested&&!(await locationBelongsToTenant(requested,tenant)))throw Object.assign(new Error('A kiválasztott telephely nem tartozik ehhez a vállalathoz.'),{status:403});
  return{capa,tenant};
}

async function workqueueScope(req:AuthRequest){
  const tenant=await tenantId(req);
  const allowed=await tenantLocationIds(tenant);
  const requested=loc(req);
  if(requested&&!allowed.includes(requested))throw Object.assign(new Error('A kiválasztott telephely nem tartozik ehhez a vállalathoz.'),{status:403});
  return{tenant,locations:requested?[requested]:allowed,requested};
}

router.get('/intelligence/capa/improvement-workqueue/summary',async(req:AuthRequest,res,next)=>{try{
  const{locations}=await workqueueScope(req);res.json(await getExceptionCapaManagementQueueSummary(locations));
}catch(error:any){sendError(error,res,next)}});

router.get('/intelligence/capa/improvement-workqueue',async(req:AuthRequest,res,next)=>{try{
  const{locations,requested}=await workqueueScope(req);
  res.json(await listExceptionCapaManagementQueue(locations,{
    status:String(req.query.status||''),severity:String(req.query.severity||''),owner:String(req.query.owner||''),q:String(req.query.q||''),
    locationId:requested,onlyOverdue:String(req.query.overdue||'')==='1',onlyUnassigned:String(req.query.unassigned||'')==='1',limit:Number(req.query.limit||100),
  }));
}catch(error:any){sendError(error,res,next)}});

router.post('/intelligence/capa/:id/improvement-workqueue/assign',async(req:AuthRequest,res,next)=>{try{
  await scope(req);
  res.json(await assignExceptionCapaManagementOwner(String(req.params.id),actor(req),{ownerKey:req.body?.owner_key,ownerTeam:req.body?.owner_team,note:req.body?.note}));
}catch(error:any){sendError(error,res,next)}});

router.post('/intelligence/capa/:id/improvement-workqueue/acknowledge',async(req:AuthRequest,res,next)=>{try{
  await scope(req);res.json(await acknowledgeExceptionCapaManagementAssignment(String(req.params.id),actor(req),req.body?.note));
}catch(error:any){sendError(error,res,next)}});

router.get('/intelligence/capa/:id/improvement-recommendation',async(req:AuthRequest,res,next)=>{try{
  const{tenant}=await scope(req);res.json(await getExceptionCapaImprovementRecommendation(String(req.params.id),tenant));
}catch(error:any){sendError(error,res,next)}});

router.post('/intelligence/capa/:id/improvement-recommendation/refresh',async(req:AuthRequest,res,next)=>{try{
  const{tenant}=await scope(req);await refreshExceptionCapaImprovementRecommendation(String(req.params.id),actor(req));res.json(await getExceptionCapaImprovementRecommendation(String(req.params.id),tenant));
}catch(error:any){sendError(error,res,next)}});

router.post('/intelligence/capa/:id/improvement-recommendation/dismiss',async(req:AuthRequest,res,next)=>{try{
  const{tenant}=await scope(req);await dismissExceptionCapaImprovementRecommendation(String(req.params.id),actor(req),String(req.body?.note||''));res.json(await getExceptionCapaImprovementRecommendation(String(req.params.id),tenant));
}catch(error:any){sendError(error,res,next)}});

export default router;
