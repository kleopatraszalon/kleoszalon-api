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

const router=Router();
startExceptionCommandCenterScheduler();
startExceptionCommandCenterIntelligenceScheduler();
startExceptionCapaScheduler();
void ensureExceptionCommandCenterSchema().catch(error=>console.error("[exception-center] startup schema bootstrap failed",error));
void ensureExceptionIntelligenceSchema().catch(error=>console.error("[exception-intelligence] startup schema bootstrap failed",error));
void ensureExceptionCapaSchema().catch(error=>console.error("[exception-capa] startup schema bootstrap failed",error));

const actor=(req:AuthRequest)=>String(req.user?.email||req.user?.id||"management-user");
const loc=(req:AuthRequest)=>String(req.query.location_id||req.user?.location_id||"").trim()||null;
const sendError=(error:any,res:any,next:any)=>error?.status?res.status(error.status).json({message:error.message}):next(error);

router.use(async(_req,_res,next)=>{try{await ensureExceptionCommandCenterSchema();next()}catch(error){next(error)}});

router.get("/summary",async(req:AuthRequest,res,next)=>{try{res.json(await exceptionCenterSummary(loc(req)))}catch(error){next(error)}});
router.get("/cases",async(req:AuthRequest,res,next)=>{try{res.json({items:await listExceptionCases({...req.query,location_id:loc(req)})})}catch(error){next(error)}});
router.get("/cases/:id",async(req:AuthRequest,res,next)=>{try{res.json(await getExceptionCase(String(req.params.id)))}catch(error:any){sendError(error,res,next)}});
router.patch("/cases/:id",async(req:AuthRequest,res,next)=>{try{res.json(await updateExceptionCase(String(req.params.id),req.body||{},actor(req)))}catch(error:any){sendError(error,res,next)}});
router.post("/cases/:id/comment",async(req:AuthRequest,res,next)=>{try{res.json(await addExceptionComment(String(req.params.id),String(req.body?.message||""),actor(req)))}catch(error:any){sendError(error,res,next)}});
router.post("/cases/bulk",async(req:AuthRequest,res,next)=>{try{res.json(await bulkExceptionAction(Array.isArray(req.body?.ids)?req.body.ids:[],req.body||{},actor(req)))}catch(error:any){sendError(error,res,next)}});
router.post("/sync",async(_req:AuthRequest,res,next)=>{try{const sync=await syncExceptionCommandCenter();const consistency=await reconcileExceptionCommandCenterConsistency();const intelligence=await runExceptionIntelligenceCycle();const capa=await syncExceptionCapaCandidates();res.json({...sync,consistency,intelligence,capa})}catch(error){next(error)}});
router.post("/consistency",async(_req:AuthRequest,res,next)=>{try{res.json(await reconcileExceptionCommandCenterConsistency())}catch(error){next(error)}});
router.get("/routing-rules",async(_req:AuthRequest,res,next)=>{try{res.json({items:await listExceptionRoutingRules()})}catch(error){next(error)}});
router.put("/routing-rules/:category",async(req:AuthRequest,res,next)=>{try{res.json(await updateExceptionRoutingRule(String(req.params.category),req.body||{},actor(req)))}catch(error:any){sendError(error,res,next)}});

router.get("/intelligence/dashboard",async(req:AuthRequest,res,next)=>{try{res.json(await getExceptionIntelligenceDashboard(Number(req.query.days||30),loc(req)))}catch(error){next(error)}});
router.post("/intelligence/run",async(_req:AuthRequest,res,next)=>{try{const intelligence=await runExceptionIntelligenceCycle();const capa=await syncExceptionCapaCandidates();res.json({...intelligence,capa})}catch(error){next(error)}});
router.get("/intelligence/escalation-rules",async(_req:AuthRequest,res,next)=>{try{res.json({items:await listExceptionEscalationRules()})}catch(error){next(error)}});
router.put("/intelligence/escalation-rules/:severity",async(req:AuthRequest,res,next)=>{try{res.json(await updateExceptionEscalationRule(String(req.params.severity),req.body||{},actor(req)))}catch(error:any){sendError(error,res,next)}});
router.post("/intelligence/brief/:type",async(req:AuthRequest,res,next)=>{try{const type=String(req.params.type);if(type!=="morning"&&type!=="evening")return res.status(400).json({message:"A brief típusa morning vagy evening lehet."});res.json(await sendExceptionExecutiveBrief(type))}catch(error){next(error)}});

router.get("/intelligence/capa/summary",async(req:AuthRequest,res,next)=>{try{res.json(await exceptionCapaSummary(loc(req)))}catch(error){next(error)}});
router.get("/intelligence/capa",async(req:AuthRequest,res,next)=>{try{res.json({items:await listExceptionCapas({...req.query,location_id:loc(req)})})}catch(error){next(error)}});
router.post("/intelligence/capa/sync",async(_req:AuthRequest,res,next)=>{try{res.json(await syncExceptionCapaCandidates())}catch(error){next(error)}});
router.get("/intelligence/capa/:id",async(req:AuthRequest,res,next)=>{try{res.json(await getExceptionCapa(String(req.params.id)))}catch(error:any){sendError(error,res,next)}});
router.patch("/intelligence/capa/:id",async(req:AuthRequest,res,next)=>{try{res.json(await updateExceptionCapa(String(req.params.id),req.body||{},actor(req)))}catch(error:any){sendError(error,res,next)}});

router.get("/export.csv",async(req:AuthRequest,res,next)=>{try{const csv=await exportExceptionCasesCsv({...req.query,location_id:loc(req)});res.setHeader("Content-Type","text/csv; charset=utf-8");res.setHeader("Content-Disposition",`attachment; filename="kleo-exception-center-${new Date().toISOString().slice(0,10)}.csv"`);res.send(csv)}catch(error){next(error)}});

export default router;