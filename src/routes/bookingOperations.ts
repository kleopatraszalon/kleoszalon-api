import { Router } from "express";
import crypto from "crypto";
import db from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

const actor = (req: AuthRequest) => req.user?.email || String(req.user?.id || "unknown");

router.get("/waitlist", async (req, res) => {
  try {
    const locationId = String(req.query.location_id || "").trim() || null;
    const status = String(req.query.status || "waiting").trim();
    const { rows } = await db.query(`SELECT w.*,COALESCE(e.full_name,e.name) employee_name,l.name location_name
      FROM booking_waitlist w LEFT JOIN employees e ON e.id=w.preferred_employee_id LEFT JOIN locations l ON l.id=w.location_id
      WHERE ($1::uuid IS NULL OR w.location_id=$1::uuid) AND ($2='all' OR w.status=$2)
      ORDER BY w.created_at`, [locationId,status]);
    res.json(rows);
  } catch (error: any) { res.status(500).json({ error: "A várólista nem tölthető be.", detail: error?.message || String(error) }); }
});

router.patch("/waitlist/:id", async (req, res) => {
  try {
    const status = String(req.body?.status || "").trim();
    if (!['waiting','contacted','booked','cancelled'].includes(status)) return res.status(400).json({ error: "Érvénytelen várólista állapot." });
    const { rows } = await db.query(`UPDATE booking_waitlist SET status=$2,note=COALESCE($3,note),updated_at=now() WHERE id=$1::uuid RETURNING *`, [req.params.id,status,req.body?.note||null]);
    if (!rows[0]) return res.status(404).json({ error: "A várólista-bejegyzés nem található." });
    res.json(rows[0]);
  } catch (error: any) { res.status(500).json({ error: "A várólista nem módosítható.", detail: error?.message || String(error) }); }
});

router.get("/breaks", async (req, res) => {
  try {
    const locationId = String(req.query.location_id || "").trim() || null;
    const from = String(req.query.from || new Date().toISOString());
    const toDate = new Date(from); toDate.setDate(toDate.getDate()+31);
    const to = String(req.query.to || toDate.toISOString());
    const { rows } = await db.query(`SELECT b.*,COALESCE(e.full_name,e.name) employee_name FROM appointment_technical_breaks b
      LEFT JOIN employees e ON e.id=b.employee_id WHERE ($1::uuid IS NULL OR b.location_id=$1::uuid)
      AND b.start_time<$3::timestamptz AND b.end_time>$2::timestamptz ORDER BY b.start_time`, [locationId,from,to]);
    res.json(rows);
  } catch (error: any) { res.status(500).json({ error: "A technikai szünetek nem tölthetők be.", detail: error?.message || String(error) }); }
});

router.post("/breaks", async (req: AuthRequest, res) => {
  try {
    const { location_id,employee_id,start_time,end_time,title,note } = req.body || {};
    if (!location_id || !employee_id || !start_time || !end_time || new Date(end_time)<=new Date(start_time)) return res.status(400).json({ error: "Hiányos vagy hibás technikai szünet." });
    const conflict = await db.query(`SELECT id FROM appointments WHERE employee_id=$1::uuid AND status NOT IN ('cancelled','canceled','no_show')
      AND start_time<$3::timestamptz AND end_time>$2::timestamptz LIMIT 1`, [employee_id,start_time,end_time]);
    if (conflict.rowCount) return res.status(409).json({ error: "A szünet foglalással ütközik." });
    const { rows } = await db.query(`INSERT INTO appointment_technical_breaks(location_id,employee_id,start_time,end_time,title,note,created_by)
      VALUES($1::uuid,$2::uuid,$3::timestamptz,$4::timestamptz,$5,$6,$7) RETURNING *`,
      [location_id,employee_id,start_time,end_time,title||'Technikai szünet',note||null,actor(req)]);
    res.status(201).json(rows[0]);
  } catch (error: any) { res.status(500).json({ error: "A technikai szünet nem menthető.", detail: error?.message || String(error) }); }
});

router.delete("/breaks/:id", async (_req, res) => {
  try { const r=await db.query(`DELETE FROM appointment_technical_breaks WHERE id=$1::uuid RETURNING id`,[_req.params.id]); if(!r.rowCount)return res.status(404).json({error:'A szünet nem található.'}); res.json({ok:true}); }
  catch(error:any){res.status(500).json({error:'A technikai szünet nem törölhető.',detail:error?.message||String(error)});}
});

router.get("/appointments/:id/history", async (req, res) => {
  try { const { rows }=await db.query(`SELECT * FROM appointment_change_log WHERE appointment_id=$1::uuid ORDER BY created_at DESC`,[req.params.id]); res.json(rows); }
  catch(error:any){res.status(500).json({error:'A változástörténet nem tölthető be.',detail:error?.message||String(error)});}
});

router.post("/appointments/:id/cancel", async (req: AuthRequest,res)=>{
  const cx=await db.connect();
  try{
    await cx.query('BEGIN');
    const before=await cx.query(`SELECT * FROM appointments WHERE id=$1::uuid FOR UPDATE`,[req.params.id]);
    if(!before.rows[0]){await cx.query('ROLLBACK');return res.status(404).json({error:'A foglalás nem található.'});}
    const reason=String(req.body?.reason||'Recepciós lemondás').trim();
    const updated=await cx.query(`UPDATE appointments SET status='cancelled',cancellation_reason=$2,cancelled_at=now(),updated_at=now() WHERE id=$1::uuid RETURNING *`,[req.params.id,reason]);
    await cx.query(`INSERT INTO appointment_change_log(appointment_id,action,actor_key,before_data,after_data,note) VALUES($1::uuid,'cancelled',$2,$3::jsonb,$4::jsonb,$5)`,[req.params.id,actor(req),JSON.stringify(before.rows[0]),JSON.stringify(updated.rows[0]),reason]);
    await cx.query('COMMIT'); res.json(updated.rows[0]);
  }catch(error:any){await cx.query('ROLLBACK').catch(()=>undefined);res.status(500).json({error:'A foglalás nem mondható le.',detail:error?.message||String(error)});}finally{cx.release();}
});

router.post("/appointments/:id/reschedule", async (req:AuthRequest,res)=>{
  const { start_time,end_time,employee_id,note }=req.body||{};
  if(!start_time||!end_time)return res.status(400).json({error:'Az új kezdés és befejezés kötelező.'});
  const cx=await db.connect();
  try{
    await cx.query('BEGIN');
    const before=await cx.query(`SELECT * FROM appointments WHERE id=$1::uuid FOR UPDATE`,[req.params.id]);
    if(!before.rows[0]){await cx.query('ROLLBACK');return res.status(404).json({error:'A foglalás nem található.'});}
    const emp=employee_id||before.rows[0].employee_id;
    const conflict=await cx.query(`SELECT id FROM appointments WHERE id<>$1::uuid AND employee_id=$2::uuid AND status NOT IN ('cancelled','canceled','no_show') AND start_time<$4::timestamptz AND end_time>$3::timestamptz LIMIT 1`,[req.params.id,emp,start_time,end_time]);
    const breakConflict=await cx.query(`SELECT id FROM appointment_technical_breaks WHERE employee_id=$1::uuid AND start_time<$3::timestamptz AND end_time>$2::timestamptz LIMIT 1`,[emp,start_time,end_time]);
    if(conflict.rowCount||breakConflict.rowCount){await cx.query('ROLLBACK');return res.status(409).json({error:'Az új időpont ütközik meglévő foglalással vagy szünettel.'});}
    const updated=await cx.query(`UPDATE appointments SET employee_id=$2::uuid,start_time=$3::timestamptz,end_time=$4::timestamptz,updated_at=now() WHERE id=$1::uuid RETURNING *`,[req.params.id,emp,start_time,end_time]);
    await cx.query(`INSERT INTO appointment_change_log(appointment_id,action,actor_key,before_data,after_data,note) VALUES($1::uuid,'rescheduled',$2,$3::jsonb,$4::jsonb,$5)`,[req.params.id,actor(req),JSON.stringify(before.rows[0]),JSON.stringify(updated.rows[0]),note||'Időpont áthelyezése']);
    await cx.query('COMMIT');res.json(updated.rows[0]);
  }catch(error:any){await cx.query('ROLLBACK').catch(()=>undefined);res.status(500).json({error:'Az időpont áthelyezése sikertelen.',detail:error?.message||String(error)});}finally{cx.release();}
});

router.post("/appointments/:id/repeat", async (req:AuthRequest,res)=>{
  const count=Math.min(24,Math.max(1,Number(req.body?.count||1))); const intervalWeeks=Math.min(12,Math.max(1,Number(req.body?.interval_weeks||1)));
  const cx=await db.connect();
  try{
    await cx.query('BEGIN');
    const source=await cx.query(`SELECT * FROM appointments WHERE id=$1::uuid`,[req.params.id]); if(!source.rows[0]){await cx.query('ROLLBACK');return res.status(404).json({error:'A foglalás nem található.'});}
    const services=await cx.query(`SELECT * FROM appointment_services WHERE appointment_id=$1::uuid ORDER BY sort_order`,[req.params.id]);
    const group=source.rows[0].recurring_group_id||crypto.randomUUID(); await cx.query(`UPDATE appointments SET recurring_group_id=$2::uuid WHERE id=$1::uuid`,[req.params.id,group]);
    const created:any[]=[]; const duration=new Date(source.rows[0].end_time).getTime()-new Date(source.rows[0].start_time).getTime();
    for(let i=1;i<=count;i++){
      const start=new Date(source.rows[0].start_time);start.setDate(start.getDate()+7*intervalWeeks*i);const end=new Date(start.getTime()+duration);
      const conflict=await cx.query(`SELECT id FROM appointments WHERE employee_id=$1::uuid AND status NOT IN ('cancelled','canceled','no_show') AND start_time<$3::timestamptz AND end_time>$2::timestamptz LIMIT 1`,[source.rows[0].employee_id,start.toISOString(),end.toISOString()]);
      if(conflict.rowCount)continue;
      const r=await cx.query(`INSERT INTO appointments(employee_id,client_id,location_id,title,start_time,end_time,status,notes,booking_source,recurring_group_id,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::uuid,now()) RETURNING id`,[source.rows[0].employee_id,source.rows[0].client_id,source.rows[0].location_id,source.rows[0].title,start,end,source.rows[0].status,source.rows[0].notes,source.rows[0].booking_source||'internal',group]);
      for(const s of services.rows)await cx.query(`INSERT INTO appointment_services(appointment_id,service_id,duration_minutes,price,discount_percent,sort_order) VALUES($1,$2,$3,$4,$5,$6)`,[r.rows[0].id,s.service_id,s.duration_minutes,s.price,s.discount_percent,s.sort_order]);
      await cx.query(`INSERT INTO appointment_change_log(appointment_id,action,actor_key,note) VALUES($1::uuid,'recurring_created',$2,$3)`,[r.rows[0].id,actor(req),`Ismétlődő sorozat: ${group}`]); created.push(r.rows[0].id);
    }
    await cx.query('COMMIT');res.status(201).json({recurring_group_id:group,created_ids:created,skipped:count-created.length});
  }catch(error:any){await cx.query('ROLLBACK').catch(()=>undefined);res.status(500).json({error:'Az ismétlődő foglalások létrehozása sikertelen.',detail:error?.message||String(error)});}finally{cx.release();}
});

export default router;
