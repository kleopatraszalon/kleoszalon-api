import { Router } from "express";
import db from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { processDueBookingCommunications, queueAppointmentCommunications } from "../booking/communications";

const router=Router();
router.use(requireAuth);

let workerRunning=false;
if(process.env.BOOKING_COMMUNICATION_WORKER_DISABLED!=="1"){
  const run=async()=>{
    if(workerRunning)return;
    workerRunning=true;
    try{await processDueBookingCommunications(100)}catch(error:any){console.warn("booking communication worker:",error?.message||String(error))}finally{workerRunning=false}
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
