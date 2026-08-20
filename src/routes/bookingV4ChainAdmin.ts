import { Router } from "express";
import db from "../db";
import ensureBookingV4Chain from "../booking/ensureBookingV4Chain";

const router=Router();
router.use(async(_req,res,next)=>{try{await ensureBookingV4Chain();next()}catch(error:any){res.status(500).json({error:"A Booking 4.0 láncadatok inicializálása sikertelen.",detail:error?.message||String(error)})}});

router.get("/chains",async(req,res)=>{
  try{
    const limit=Math.max(1,Math.min(250,Number(req.query.limit||100)));
    const status=String(req.query.status||"").trim();
    const {rows}=await db.query(`
      SELECT c.id,c.status,c.location_id,c.client_id,c.start_time,c.end_time,c.total_gap_minutes,c.booking_source,c.created_at,
             l.name location_name,COALESCE(NULLIF(btrim(cl.full_name),''),NULLIF(btrim(cl.name),''),'Vendég') client_name,cl.phone,cl.email,
             COALESCE((SELECT jsonb_agg(jsonb_build_object(
               'sequence_no',i.sequence_no,'appointment_id',i.appointment_id,'service_id',i.service_id,'service_name',s.name,
               'employee_id',i.employee_id,'employee_name',COALESCE(NULLIF(btrim(e.full_name),''),NULLIF(btrim(concat_ws(' ',e.last_name,e.first_name)),''),'Munkatárs'),
               'start',i.start_time,'end',i.end_time,'appointment_status',a.status
             ) ORDER BY i.sequence_no)
             FROM booking_chain_items i JOIN services s ON s.id=i.service_id JOIN employees e ON e.id=i.employee_id JOIN appointments a ON a.id=i.appointment_id WHERE i.chain_id=c.id),'[]'::jsonb) items
      FROM booking_chains c JOIN locations l ON l.id=c.location_id JOIN clients cl ON cl.id=c.client_id
      WHERE ($1='' OR c.status=$1)
      ORDER BY c.created_at DESC LIMIT $2`,[status,limit]);
    res.json({chains:rows});
  }catch(error:any){res.status(500).json({error:"A foglalási láncok nem tölthetők be.",detail:error?.message||String(error)});}
});

export default router;
