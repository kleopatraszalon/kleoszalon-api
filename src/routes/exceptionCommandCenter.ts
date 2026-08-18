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

const router=Router();
startExceptionCommandCenterScheduler();
void ensureExceptionCommandCenterSchema().catch(error=>console.error("[exception-center] startup schema bootstrap failed",error));

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
router.post("/sync",async(_req:AuthRequest,res,next)=>{try{const sync=await syncExceptionCommandCenter();const consistency=await reconcileExceptionCommandCenterConsistency();res.json({...sync,consistency})}catch(error){next(error)}});
router.post("/consistency",async(_req:AuthRequest,res,next)=>{try{res.json(await reconcileExceptionCommandCenterConsistency())}catch(error){next(error)}});
router.get("/routing-rules",async(_req:AuthRequest,res,next)=>{try{res.json({items:await listExceptionRoutingRules()})}catch(error){next(error)}});
router.put("/routing-rules/:category",async(req:AuthRequest,res,next)=>{try{res.json(await updateExceptionRoutingRule(String(req.params.category),req.body||{},actor(req)))}catch(error:any){sendError(error,res,next)}});
router.get("/export.csv",async(req:AuthRequest,res,next)=>{try{const csv=await exportExceptionCasesCsv({...req.query,location_id:loc(req)});res.setHeader("Content-Type","text/csv; charset=utf-8");res.setHeader("Content-Disposition",`attachment; filename="kleo-exception-center-${new Date().toISOString().slice(0,10)}.csv"`);res.send(csv)}catch(error){next(error)}});

export default router;
