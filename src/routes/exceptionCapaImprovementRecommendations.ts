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
  exceptionCapaImprovementQueueSummary,
  listExceptionCapaImprovementQueue,
} from "../services/exceptionCapaImprovementQueue";
import {locationBelongsToTenant,resolveTenantIdentity} from "../saas/tenantAccess";

const router=Router();
startExceptionCapaImprovementRecommendationScheduler();
void ensureExceptionCapaImprovementRecommendationSchema().catch(error=>console.error('[exception-capa] improvement recommendation schema bootstrap failed',error));

const actor=(req:AuthRequest)=>String(req.user?.email||req.user?.id||'management-user');
const loc=(req:AuthRequest)=>String(req.query.location_id||req.user?.location_id||'').trim()||null;
const queueLoc=(req:AuthRequest)=>String(req.query.location_id||'').trim()||null;
const sendError=(error:any,res:any,next:any)=>error?.status?res.status(error.status).json({message:error.message}):String(error?.code||'')==='23514'?res.status(409).json({message:error?.message||'A governance szabály megakadályozta a műveletet.',code:'improvement_recommendation_governance_conflict'}):next(error);
const tenantId=async(req:AuthRequest)=>{const tenant=await resolveTenantIdentity(req);if(!tenant)throw Object.assign(new Error('A tenant nem azonosítható.'),{status:403});return String(tenant.id)};

async function queueScope(req:AuthRequest){
  const tenant=await tenantId(req);const location=queueLoc(req);
  if(location&&!(await locationBelongsToTenant(location,tenant)))throw Object.assign(new Error('A kiválasztott telephely nem tartozik ehhez a vállalathoz.'),{status:403});
  return{tenant,location};
}

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

router.get('/intelligence/capa/improvement-recommendations/summary',async(req:AuthRequest,res,next)=>{try{
  const{tenant,location}=await queueScope(req);res.json(await exceptionCapaImprovementQueueSummary(tenant,location));
}catch(error:any){sendError(error,res,next)}});

router.get('/intelligence/capa/improvement-recommendations',async(req:AuthRequest,res,next)=>{try{
  const{tenant,location}=await queueScope(req);res.json({items:await listExceptionCapaImprovementQueue(tenant,{...req.query,location_id:location})});
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
