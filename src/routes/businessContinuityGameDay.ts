import {Router} from "express";
import {AuthRequest} from "../middleware/auth";
import {
 acknowledgeGameDayInject,beginGameDayVerification,cancelGameDay,completeGameDay,createGameDay,
 ensureBusinessContinuityGameDaySchema,gameDaySummary,getGameDay,listGameDayPolicies,listGameDays,listGameDayTemplates,
 releaseGameDayInject,runGameDayGovernanceCycle,startGameDay,startGameDayScheduler,updateGameDayAction,updateGameDayService,updateGameDayStep
} from "../services/businessContinuityGameDay";

const router=Router();
startGameDayScheduler();
void ensureBusinessContinuityGameDaySchema().catch(error=>console.error('[gameday] schema bootstrap failed',error));
const actor=(req:AuthRequest)=>String(req.user?.email||req.user?.id||'management-user');
const location=(req:AuthRequest)=>String(req.query.location_id||req.user?.location_id||'').trim()||null;
const send=(error:any,res:any,next:any)=>String(error?.code||'')==='23514'?res.status(409).json({message:error?.message||'A GameDay governance szabály megakadályozta a műveletet.',code:'gameday_governance_conflict'}):error?.status?res.status(error.status).json({message:error.message}):next(error);
const visible=(detail:any,loc:string|null)=>!loc||!detail?.item?.location_id||String(detail.item.location_id)===loc;
router.use(async(_req,_res,next)=>{try{await ensureBusinessContinuityGameDaySchema();next()}catch(error){next(error)}});

router.get('/summary',async(req:AuthRequest,res,next)=>{try{res.json(await gameDaySummary(location(req)))}catch(error){next(error)}});
router.get('/templates',async(_req:AuthRequest,res,next)=>{try{res.json({items:await listGameDayTemplates()})}catch(error){next(error)}});
router.get('/service-readiness',async(_req:AuthRequest,res,next)=>{try{res.json({items:await listGameDayPolicies()})}catch(error){next(error)}});
router.post('/governance-cycle',async(_req:AuthRequest,res,next)=>{try{res.json(await runGameDayGovernanceCycle())}catch(error){next(error)}});
router.get('/drills',async(req:AuthRequest,res,next)=>{try{res.json({items:await listGameDays({...req.query,location_id:location(req)})})}catch(error){next(error)}});
router.post('/drills',async(req:AuthRequest,res,next)=>{try{res.status(201).json(await createGameDay({...req.body,location_id:req.body?.location_id||location(req)},actor(req)))}catch(error:any){send(error,res,next)}});
router.get('/drills/:id',async(req:AuthRequest,res,next)=>{try{const detail=await getGameDay(String(req.params.id));if(!visible(detail,location(req)))return res.status(404).json({message:'A GameDay nem található ebben a telephelyi hatókörben.'});res.json(detail)}catch(error:any){send(error,res,next)}});
router.post('/drills/:id/start',async(req:AuthRequest,res,next)=>{try{const detail=await getGameDay(String(req.params.id));if(!visible(detail,location(req)))return res.status(404).json({message:'A GameDay nem található ebben a telephelyi hatókörben.'});res.json(await startGameDay(String(req.params.id),actor(req)))}catch(error:any){send(error,res,next)}});
router.post('/drills/:id/verification',async(req:AuthRequest,res,next)=>{try{const detail=await getGameDay(String(req.params.id));if(!visible(detail,location(req)))return res.status(404).json({message:'A GameDay nem található ebben a telephelyi hatókörben.'});res.json(await beginGameDayVerification(String(req.params.id),actor(req)))}catch(error:any){send(error,res,next)}});
router.post('/drills/:id/complete',async(req:AuthRequest,res,next)=>{try{const detail=await getGameDay(String(req.params.id));if(!visible(detail,location(req)))return res.status(404).json({message:'A GameDay nem található ebben a telephelyi hatókörben.'});res.json(await completeGameDay(String(req.params.id),req.body||{},actor(req)))}catch(error:any){send(error,res,next)}});
router.post('/drills/:id/cancel',async(req:AuthRequest,res,next)=>{try{const detail=await getGameDay(String(req.params.id));if(!visible(detail,location(req)))return res.status(404).json({message:'A GameDay nem található ebben a telephelyi hatókörben.'});res.json(await cancelGameDay(String(req.params.id),req.body||{},actor(req)))}catch(error:any){send(error,res,next)}});
router.patch('/drills/:id/services/:serviceKey',async(req:AuthRequest,res,next)=>{try{const detail=await getGameDay(String(req.params.id));if(!visible(detail,location(req)))return res.status(404).json({message:'A GameDay nem található ebben a telephelyi hatókörben.'});res.json(await updateGameDayService(String(req.params.id),String(req.params.serviceKey),req.body||{},actor(req)))}catch(error:any){send(error,res,next)}});
router.patch('/drills/:id/steps/:serviceKey/:stepKey',async(req:AuthRequest,res,next)=>{try{const detail=await getGameDay(String(req.params.id));if(!visible(detail,location(req)))return res.status(404).json({message:'A GameDay nem található ebben a telephelyi hatókörben.'});res.json(await updateGameDayStep(String(req.params.id),String(req.params.serviceKey),String(req.params.stepKey),req.body||{},actor(req)))}catch(error:any){send(error,res,next)}});
router.post('/drills/:id/injects/:injectId/release',async(req:AuthRequest,res,next)=>{try{const detail=await getGameDay(String(req.params.id));if(!visible(detail,location(req)))return res.status(404).json({message:'A GameDay nem található ebben a telephelyi hatókörben.'});res.json(await releaseGameDayInject(String(req.params.id),String(req.params.injectId),actor(req)))}catch(error:any){send(error,res,next)}});
router.post('/drills/:id/injects/:injectId/ack',async(req:AuthRequest,res,next)=>{try{const detail=await getGameDay(String(req.params.id));if(!visible(detail,location(req)))return res.status(404).json({message:'A GameDay nem található ebben a telephelyi hatókörben.'});res.json(await acknowledgeGameDayInject(String(req.params.id),String(req.params.injectId),req.body||{},actor(req)))}catch(error:any){send(error,res,next)}});
router.patch('/drills/:id/actions/:actionId',async(req:AuthRequest,res,next)=>{try{const detail=await getGameDay(String(req.params.id));if(!visible(detail,location(req)))return res.status(404).json({message:'A GameDay nem található ebben a telephelyi hatókörben.'});res.json(await updateGameDayAction(String(req.params.id),String(req.params.actionId),req.body||{},actor(req)))}catch(error:any){send(error,res,next)}});

export default router;
