import {Router} from "express";
import {attributeNbaBooking,recordNbaLanding} from "../services/nbaRevenueAttribution";

const router=Router();

// Public, deliberately minimal endpoints. They never return customer/job details.
router.post("/nba/touch",async(req,res)=>{
  try{
    const result=await recordNbaLanding(String(req.body?.nba_job_id||""),String(req.headers["user-agent"]||""),String(req.headers.referer||req.headers.referrer||""));
    // Tracking must not become an oracle for internal job IDs.
    return res.status(202).json({ok:true,tracked:Boolean(result.ok)});
  }catch(error:any){console.warn("[nba-attribution] touch",error?.message||error);return res.status(202).json({ok:true,tracked:false})}
});

router.post("/nba/attribute",async(req,res)=>{
  try{
    const result=await attributeNbaBooking(String(req.body?.nba_job_id||""),String(req.body?.appointment_id||""));
    // Client mismatch / expired window stays fail-closed without leaking CRM details.
    return res.status(result.ok?202:409).json({ok:Boolean(result.ok),code:result.ok?"ATTRIBUTED":"ATTRIBUTION_REJECTED"});
  }catch(error:any){console.warn("[nba-attribution] booking",error?.message||error);return res.status(202).json({ok:true,tracked:false})}
});

export default router;
