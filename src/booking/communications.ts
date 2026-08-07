import db from "../db";
import { sendEmail } from "../mailer";

const fmtDate=(value:any)=>new Date(value).toLocaleDateString("hu-HU",{year:"numeric",month:"long",day:"numeric"});
const fmtTime=(value:any)=>new Date(value).toLocaleTimeString("hu-HU",{hour:"2-digit",minute:"2-digit"});

export async function queueAppointmentCommunications(appointmentId:string, event:"created"|"confirmed"|"cancelled"|"rescheduled"|"completed") {
  const { rows } = await db.query(`
    SELECT a.id,a.location_id,a.client_id,a.start_time,a.end_time,a.status,a.cancellation_token,
           COALESCE(c.full_name,c.name,'Vendég') client_name,c.email,
           COALESCE(e.full_name,e.name,'Szakember') employee_name,
           COALESCE(l.name,'Kleopátra Szalon') location_name,
           COALESCE(s.confirmation_enabled,true) confirmation_enabled,
           COALESCE(s.reminder_48h_enabled,true) reminder_48h_enabled,
           COALESCE(s.reminder_24h_enabled,true) reminder_24h_enabled,
           COALESCE(s.cancellation_enabled,true) cancellation_enabled,
           COALESCE(s.review_request_enabled,true) review_request_enabled,
           COALESCE(s.review_delay_hours,24) review_delay_hours
    FROM appointments a
    LEFT JOIN clients c ON c.id=a.client_id
    LEFT JOIN employees e ON e.id=a.employee_id
    LEFT JOIN locations l ON l.id=a.location_id
    LEFT JOIN booking_communication_settings s ON s.location_id=a.location_id
    WHERE a.id=$1::uuid LIMIT 1`,[appointmentId]);
  const a=rows[0];
  if(!a?.email) return {queued:0, reason:"no_email"};
  let queued=0;
  const insert=async(eventType:string,scheduledAt:Date,subject:string,text:string)=>{
    if(scheduledAt.getTime()<Date.now()-60_000) return;
    await db.query(`INSERT INTO booking_communication_queue
      (appointment_id,location_id,client_id,event_type,recipient,subject,body_text,scheduled_at)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8::timestamptz)
      ON CONFLICT DO NOTHING`,[a.id,a.location_id,a.client_id,eventType,a.email,subject,text,scheduledAt.toISOString()]);
    queued+=1;
  };
  const where=`${a.location_name}, ${fmtDate(a.start_time)} ${fmtTime(a.start_time)}`;
  const cancelLink=a.cancellation_token ? `${process.env.PUBLIC_WEB_URL||"https://weblap-o3g6.onrender.com"}/booking/cancel/${a.cancellation_token}` : "";

  if(event==="created" && a.confirmation_enabled){
    await insert("booking_created",new Date(),"Kleopátra Szalon – foglalási igény",`Kedves ${a.client_name}!\nFoglalási igényét rögzítettük.\n${where}\nSzakember: ${a.employee_name}\nStátusz: ${a.status}.\n${cancelLink?`Lemondás: ${cancelLink}`:""}`);
  }
  if(event==="confirmed" && a.confirmation_enabled){
    await insert("booking_confirmed",new Date(),"Kleopátra Szalon – időpont visszaigazolva",`Kedves ${a.client_name}!\nIdőpontját visszaigazoltuk.\n${where}\nSzakember: ${a.employee_name}.\n${cancelLink?`Lemondás: ${cancelLink}`:""}`);
  }
  if(event==="rescheduled" && a.confirmation_enabled){
    await insert("booking_rescheduled",new Date(),"Kleopátra Szalon – időpont módosult",`Kedves ${a.client_name}!\nIdőpontja módosult.\nÚj időpont: ${where}\nSzakember: ${a.employee_name}.`);
  }
  if(event==="cancelled" && a.cancellation_enabled){
    await db.query(`UPDATE booking_communication_queue SET status='cancelled',updated_at=now() WHERE appointment_id=$1::uuid AND status='pending'`,[a.id]);
    await insert("booking_cancelled",new Date(),"Kleopátra Szalon – időpont lemondva",`Kedves ${a.client_name}!\nA(z) ${where} időpontját lemondtuk.`);
  }
  if(event==="completed" && a.review_request_enabled){
    const when=new Date(Date.now()+Number(a.review_delay_hours||24)*3600_000);
    await insert("review_request",when,"Kleopátra Szalon – hogy érezte magát nálunk?",`Kedves ${a.client_name}!\nKöszönjük, hogy minket választott. Örömmel vesszük visszajelzését a látogatásáról.`);
  }
  if(["created","confirmed","rescheduled"].includes(event)){
    await db.query(`UPDATE booking_communication_queue SET status='cancelled',updated_at=now()
      WHERE appointment_id=$1::uuid AND event_type IN ('reminder_48h','reminder_24h') AND status='pending'`,[a.id]);
    const startMs=new Date(a.start_time).getTime();
    if(a.reminder_48h_enabled) await insert("reminder_48h",new Date(startMs-48*3600_000),"Kleopátra Szalon – emlékeztető az időpontjáról",`Kedves ${a.client_name}!\n48 óra múlva várjuk: ${where}.\nSzakember: ${a.employee_name}.`);
    if(a.reminder_24h_enabled) await insert("reminder_24h",new Date(startMs-24*3600_000),"Kleopátra Szalon – holnap várjuk",`Kedves ${a.client_name}!\nHolnap várjuk: ${where}.\nSzakember: ${a.employee_name}.\n${cancelLink?`Ha mégsem tud jönni: ${cancelLink}`:""}`);
  }
  return {queued};
}

export async function processDueBookingCommunications(limit=50){
  const cx=await db.connect();
  try{
    await cx.query("BEGIN");
    const {rows}=await cx.query(`SELECT * FROM booking_communication_queue
      WHERE status='pending' AND scheduled_at<=now()
      ORDER BY scheduled_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED`,[limit]);
    for(const item of rows){
      await cx.query(`UPDATE booking_communication_queue SET status='processing',attempt_count=attempt_count+1,updated_at=now() WHERE id=$1`,[item.id]);
      try{
        if(item.channel!=="email") throw new Error(`A ${item.channel} csatorna még nincs konfigurálva.`);
        const result=await sendEmail({to:item.recipient,subject:item.subject,text:item.body_text,html:item.body_html||undefined});
        await cx.query(`UPDATE booking_communication_queue SET status='sent',sent_at=now(),error_text=NULL,updated_at=now() WHERE id=$1`,[item.id]);
        if((result as any)?.logged) console.log(`[BOOKING COMM] SMTP disabled, logged queue=${item.id}`);
      }catch(error:any){
        await cx.query(`UPDATE booking_communication_queue SET status='failed',failed_at=now(),error_text=$2,updated_at=now() WHERE id=$1`,[item.id,error?.message||String(error)]);
      }
    }
    await cx.query("COMMIT");
    return {processed:rows.length};
  }catch(error){await cx.query("ROLLBACK").catch(()=>undefined);throw error}finally{cx.release()}
}
