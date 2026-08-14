import { Router } from "express";
import db from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { parseRoleKeys } from "../security/roles";
import { processDueBookingCommunications, queueAppointmentCommunications, resolveRecoveredBookingCommunicationAuthFailures } from "../booking/communications";
import { classifyBookingCommunicationFailure, normalizeBookingCommunicationFailure } from "../booking/communicationFailureAnalysis";
import { verifyEmailTransport } from "../mailer";

const router=Router();
router.use(requireAuth);

const canAnalyseFailures=(req:AuthRequest)=>{const roles=parseRoleKeys(req.user?.role);return roles.includes("admin")||roles.includes("manager")};

let workerRunning=false;
if(process.env.BOOKING_COMMUNICATION_WORKER_DISABLED!=="1"){
  const run=async()=>{
    if(workerRunning)return;
    workerRunning=true;
    try{
      const recovery=await resolveRecoveredBookingCommunicationAuthFailures();
      if(recovery.resolved>0)console.info(`[booking communication] ${recovery.resolved} történeti SMTP-auth hiba lezárva.`);
      await processDueBookingCommunications(100);
    }catch(error:any){console.warn("booking communication worker:",error?.message||String(error))}finally{workerRunning=false}
  };
  setTimeout(()=>void run(),15_000);
  setInterval(()=>void run(),5*60_000);
}

router.get("/queue",async(req:AuthRequest,res,next)=>{try{
  const locationId=String(req.query.location_id||req.user?.location_id||"").trim();
  const status=String(req.query.status||"").trim();
  const params:any[]=[];let where="WHERE 1=1";
  if(locationId){params.push(locationId);where+=` AND q.location_id::text=$${params.length}::text`;}
  if(status){params.push(status);where+=` AND q.status=$${params.length}`;}
  const{rows}=await db.query(`SELECT q.*,COALESCE(c.full_name,c.name,'Vendég') client_name,l.name location_name,a.start_time,a.status appointment_status FROM booking_communication_queue q LEFT JOIN clients c ON c.id=q.client_id LEFT JOIN locations l ON l.id=q.location_id LEFT JOIN appointments a ON a.id=q.appointment_id ${where} ORDER BY q.created_at DESC LIMIT 300`,params);
  res.json(rows);
}catch(err){next(err)}});

router.get("/failure-analysis",async(req:AuthRequest,res,next)=>{try{
  if(!canAnalyseFailures(req))return res.status(403).json({error:"A foglalási értesítések hibaelemzése csak adminisztrátor vagy vezető számára érhető el."});
  const scopeAll=String(req.query.scope||"").trim().toLowerCase()==="all";
  const locationId=scopeAll?"":String(req.query.location_id||req.user?.location_id||"").trim();
  const params:any[]=[];let locationWhere="";
  if(locationId){params.push(locationId);locationWhere=` AND q.location_id::text=$${params.length}::text`;}

  const{rows:historicalRows}=await db.query(`SELECT
      q.id::text,q.location_id::text,q.channel,q.event_type,q.status,q.error_text,q.attempt_count,
      q.created_at,q.failed_at,q.resolved_at,q.resolution_code,q.resolution_note,l.name location_name
    FROM booking_communication_queue q
    LEFT JOIN locations l ON l.id=q.location_id
    WHERE q.status='failed'${locationWhere}
    ORDER BY COALESCE(q.failed_at,q.created_at) DESC`,params);
  const rows=historicalRows.filter((row:any)=>!row.resolved_at);

  const now=Date.now();
  const dayMs=24*60*60*1000;
  const causeMap=new Map<string,any>();
  const channelMap=new Map<string,number>();
  const eventMap=new Map<string,number>();
  const locationMap=new Map<string,{location_id:string|null;label:string;count:number}>();
  const signatureMap=new Map<string,number>();
  let failedLast24h=0,failedLast7d=0,missingErrorText=0;
  let oldestMs=Number.POSITIVE_INFINITY,newestMs=0;

  for(const row of rows){
    const ts=new Date(row.failed_at||row.created_at).getTime();
    if(Number.isFinite(ts)){
      if(now-ts<=dayMs)failedLast24h++;
      if(now-ts<=7*dayMs)failedLast7d++;
      oldestMs=Math.min(oldestMs,ts);newestMs=Math.max(newestMs,ts);
    }
    if(!String(row.error_text||"").trim())missingErrorText++;

    const cause=classifyBookingCommunicationFailure(row.error_text,row.channel);
    const current=causeMap.get(cause.key)||{...cause,count:0};current.count++;causeMap.set(cause.key,current);
    const channel=String(row.channel||"unknown");channelMap.set(channel,(channelMap.get(channel)||0)+1);
    const event=String(row.event_type||"unknown");eventMap.set(event,(eventMap.get(event)||0)+1);
    const locationKey=String(row.location_id||"none");const currentLocation=locationMap.get(locationKey)||{location_id:row.location_id||null,label:String(row.location_name||"Ismeretlen telephely"),count:0};currentLocation.count++;locationMap.set(locationKey,currentLocation);
    const signature=normalizeBookingCommunicationFailure(row.error_text);signatureMap.set(signature,(signatureMap.get(signature)||0)+1);
  }

  const duplicateParams:any[]=[];let duplicateWhere="";
  if(locationId){duplicateParams.push(locationId);duplicateWhere=` AND q.location_id::text=$${duplicateParams.length}::text`;}
  const duplicateResult=await db.query(`WITH ordered AS (
      SELECT q.id,q.appointment_id,q.event_type,q.channel,q.recipient,q.created_at,
        LAG(q.created_at) OVER(PARTITION BY q.appointment_id,q.event_type,q.channel,q.recipient ORDER BY q.created_at) prev_created_at
      FROM booking_communication_queue q
      WHERE q.appointment_id IS NOT NULL AND q.status<>'cancelled'${duplicateWhere}
    ) SELECT COUNT(*)::int duplicate_rows
      FROM ordered
      WHERE prev_created_at IS NOT NULL
        AND created_at>=prev_created_at
        AND created_at-prev_created_at<=interval '10 seconds'`,duplicateParams);
  const duplicateCandidates=Number(duplicateResult.rows[0]?.duplicate_rows||0);
  const total=rows.length;
  const historicalTotal=historicalRows.length;
  const resolvedTotal=historicalTotal-total;
  const toCountArray=(map:Map<string,number>)=>[...map.entries()].map(([key,count])=>({key,count})).sort((a,b)=>b.count-a.count);

  const causes=[...causeMap.values()].sort((a,b)=>b.count-a.count).map(x=>({...x,percentage:total?Math.round((x.count/total)*1000)/10:0}));
  const topErrors=[...signatureMap.entries()].map(([message,count])=>({message,count,percentage:total?Math.round((count/total)*1000)/10:0})).sort((a,b)=>b.count-a.count).slice(0,12);
  const emailTransport=await verifyEmailTransport();

  res.json({
    generated_at:new Date().toISOString(),
    scope:locationId?"location":"all",
    location_id:locationId||null,
    total_failed:total,
    active_failed:total,
    historical_total_failed:historicalTotal,
    resolved_failed:resolvedTotal,
    failed_last_24h:failedLast24h,
    failed_last_7d:failedLast7d,
    stale_older_than_7d:Math.max(0,total-failedLast7d),
    missing_error_text:missingErrorText,
    oldest_failed_at:Number.isFinite(oldestMs)?new Date(oldestMs).toISOString():null,
    newest_failed_at:newestMs?new Date(newestMs).toISOString():null,
    duplicate_candidates:duplicateCandidates,
    provider_status:{
      email:emailTransport,
      sms:{enabled:process.env.DISABLE_SMS!=="1",configured:Boolean(String(process.env.SMS_GATEWAY_URL||"").trim()),token_configured:Boolean(String(process.env.SMS_GATEWAY_TOKEN||"").trim())}
    },
    causes,
    channels:toCountArray(channelMap),
    events:toCountArray(eventMap),
    locations:[...locationMap.values()].sort((a,b)=>b.count-a.count),
    top_errors:topErrors,
    safety:{bulk_requeue_allowed:false,message:"A sikertelen értesítések automatikus tömeges újraküldése tiltott. Csak aktuális foglalás és helyreállt szolgáltató esetén szabad célzottan újraküldeni."}
  });
}catch(err){next(err)}});

router.post("/failure-analysis/reconcile",async(req:AuthRequest,res,next)=>{try{
  if(!canAnalyseFailures(req))return res.status(403).json({error:"Az incidenslezárás csak adminisztrátor vagy vezető számára érhető el."});
  res.json(await resolveRecoveredBookingCommunicationAuthFailures());
}catch(err){next(err)}});

router.get("/settings",async(req:AuthRequest,res,next)=>{try{
  const locationId=String(req.query.location_id||req.user?.location_id||"").trim();
  if(!locationId)return res.status(400).json({error:"location_id kötelező."});
  const{rows}=await db.query(`SELECT * FROM booking_communication_settings WHERE location_id=$1::uuid`,[locationId]);
  res.json(rows[0]||null);
}catch(err){next(err)}});

router.put("/settings",async(req:AuthRequest,res,next)=>{try{
  const locationId=String(req.body?.location_id||req.user?.location_id||"").trim();
  if(!locationId)return res.status(400).json({error:"location_id kötelező."});
  const b=req.body||{};
  const{rows}=await db.query(`INSERT INTO booking_communication_settings(
      location_id,confirmation_enabled,reminder_48h_enabled,reminder_24h_enabled,cancellation_enabled,
      waitlist_enabled,review_request_enabled,review_delay_hours,email_channel_enabled,sms_channel_enabled,updated_at
    ) VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
    ON CONFLICT(location_id) DO UPDATE SET
      confirmation_enabled=EXCLUDED.confirmation_enabled,
      reminder_48h_enabled=EXCLUDED.reminder_48h_enabled,
      reminder_24h_enabled=EXCLUDED.reminder_24h_enabled,
      cancellation_enabled=EXCLUDED.cancellation_enabled,
      waitlist_enabled=EXCLUDED.waitlist_enabled,
      review_request_enabled=EXCLUDED.review_request_enabled,
      review_delay_hours=EXCLUDED.review_delay_hours,
      email_channel_enabled=EXCLUDED.email_channel_enabled,
      sms_channel_enabled=EXCLUDED.sms_channel_enabled,
      updated_at=now()
    RETURNING *`,[
      locationId,b.confirmation_enabled!==false,b.reminder_48h_enabled!==false,b.reminder_24h_enabled!==false,
      b.cancellation_enabled!==false,b.waitlist_enabled!==false,b.review_request_enabled!==false,
      Math.max(0,Number(b.review_delay_hours||24)),b.email_channel_enabled!==false,b.sms_channel_enabled===true
    ]);
  res.json(rows[0]);
}catch(err){next(err)}});

router.post("/process",async(_req,res,next)=>{try{res.json(await processDueBookingCommunications(100));}catch(err){next(err)}});
router.post("/appointments/:id/requeue",async(req,res,next)=>{try{const event=String(req.body?.event||"confirmed") as any;res.json(await queueAppointmentCommunications(req.params.id,event));}catch(err){next(err)}});

export default router;
