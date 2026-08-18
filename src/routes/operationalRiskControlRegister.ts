import {Router} from "express";
import {AuthRequest} from "../middleware/auth";
import {
 createOperationalKri,createOperationalRisk,ensureOperationalRiskControlSchema,getOperationalRisk,linkOperationalControl,
 listOperationalControls,listOperationalRisks,measureOperationalKri,operationalRiskSummary,runOperationalRiskGovernanceCycle,
 startOperationalRiskScheduler,syncOperationalRiskRegister,testOperationalControl,updateOperationalRisk,upsertOperationalControl
} from "../services/operationalRiskControlRegister";
import {startOperationalRiskExceptionBridge,syncOperationalRiskExceptions} from "../services/operationalRiskExceptionBridge";

const router=Router();
startOperationalRiskScheduler();
startOperationalRiskExceptionBridge();
void ensureOperationalRiskControlSchema().catch(error=>console.error('[operational-risk] schema bootstrap failed',error));
const actor=(req:AuthRequest)=>String(req.user?.email||req.user?.id||'management-user');
const location=(req:AuthRequest)=>String(req.query.location_id||req.user?.location_id||'').trim()||null;
const visible=(detail:any,loc:string|null)=>!loc||!detail?.item?.location_id||String(detail.item.location_id)===loc;
const send=(error:any,res:any,next:any)=>String(error?.code||'')==='23514'?res.status(409).json({message:error?.message||'A risk governance szabály megakadályozta a műveletet.',code:'operational_risk_governance_conflict'}):error?.status?res.status(error.status).json({message:error.message}):next(error);
router.use(async(_req,_res,next)=>{try{await ensureOperationalRiskControlSchema();next()}catch(error){next(error)}});

router.get('/summary',async(req:AuthRequest,res,next)=>{try{res.json(await operationalRiskSummary(location(req)))}catch(error){next(error)}});
router.post('/sync',async(_req:AuthRequest,res,next)=>{try{const risk=await syncOperationalRiskRegister();const exceptions=await syncOperationalRiskExceptions();res.json({...risk,exceptions})}catch(error){next(error)}});
router.post('/governance-cycle',async(_req:AuthRequest,res,next)=>{try{const risk=await runOperationalRiskGovernanceCycle();const exceptions=await syncOperationalRiskExceptions();res.json({...risk,exceptions})}catch(error){next(error)}});
router.get('/risks',async(req:AuthRequest,res,next)=>{try{res.json({items:await listOperationalRisks({...req.query,location_id:location(req)})})}catch(error){next(error)}});
router.post('/risks',async(req:AuthRequest,res,next)=>{try{res.status(201).json(await createOperationalRisk({...req.body,location_id:req.body?.location_id||location(req)},actor(req)))}catch(error:any){send(error,res,next)}});
router.get('/risks/:id',async(req:AuthRequest,res,next)=>{try{const detail=await getOperationalRisk(String(req.params.id));if(!visible(detail,location(req)))return res.status(404).json({message:'A risk nem található ebben a telephelyi hatókörben.'});res.json(detail)}catch(error:any){send(error,res,next)}});
router.patch('/risks/:id',async(req:AuthRequest,res,next)=>{try{const detail=await getOperationalRisk(String(req.params.id));if(!visible(detail,location(req)))return res.status(404).json({message:'A risk nem található ebben a telephelyi hatókörben.'});res.json(await updateOperationalRisk(String(req.params.id),req.body||{},actor(req)))}catch(error:any){send(error,res,next)}});
router.post('/risks/:id/controls/:controlId/link',async(req:AuthRequest,res,next)=>{try{const detail=await getOperationalRisk(String(req.params.id));if(!visible(detail,location(req)))return res.status(404).json({message:'A risk nem található ebben a telephelyi hatókörben.'});res.json(await linkOperationalControl(String(req.params.id),String(req.params.controlId),req.body||{},actor(req)))}catch(error:any){send(error,res,next)}});
router.post('/risks/:id/kri',async(req:AuthRequest,res,next)=>{try{const detail=await getOperationalRisk(String(req.params.id));if(!visible(detail,location(req)))return res.status(404).json({message:'A risk nem található ebben a telephelyi hatókörben.'});res.status(201).json(await createOperationalKri(String(req.params.id),req.body||{},actor(req)))}catch(error:any){send(error,res,next)}});
router.get('/controls',async(_req:AuthRequest,res,next)=>{try{res.json({items:await listOperationalControls()})}catch(error){next(error)}});
router.post('/controls',async(req:AuthRequest,res,next)=>{try{res.status(201).json(await upsertOperationalControl(req.body||{},actor(req)))}catch(error:any){send(error,res,next)}});
router.patch('/controls/:id',async(req:AuthRequest,res,next)=>{try{res.json(await upsertOperationalControl(req.body||{},actor(req),String(req.params.id)))}catch(error:any){send(error,res,next)}});
router.post('/controls/:id/tests',async(req:AuthRequest,res,next)=>{try{res.status(201).json(await testOperationalControl(String(req.params.id),req.body||{},actor(req)))}catch(error:any){send(error,res,next)}});
router.post('/kri/:id/measurements',async(req:AuthRequest,res,next)=>{try{res.status(201).json(await measureOperationalKri(String(req.params.id),req.body||{},actor(req)))}catch(error:any){send(error,res,next)}});

export default router;
