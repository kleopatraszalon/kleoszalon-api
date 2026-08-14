import db from "../db";
import { sendEmail, verifyEmailTransport, type EmailTransportHealth } from "../mailer";
import { sendSms } from "../sms";
import ensureOnlineBooking from "./ensureOnlineBooking";
import { classifyBookingCommunicationFailure, stripBookingCommunicationRetryPrefix } from "./communicationFailureAnalysis";

const fmtDate=(value:any)=>new Date(value).toLocaleDateString("hu-HU",{year:"numeric",month:"long",day:"numeric",timeZone:"Europe/Budapest"});
const fmtTime=(value:any)=>new Date(value).toLocaleTimeString("hu-HU",{hour:"2-digit",minute:"2-digit",timeZone:"Europe/Budapest"});
const MAX_SEND_ATTEMPTS=3;
const retryDelayMinutes=(attempt:number)=>Math.min(60,5*Math.pow(2,Math.max(0,attempt-1)));
const PROVIDER_RECHECK_MINUTES=Math.max(10,Math.min(120,Number(process.env.BOOKING_PROVIDER_RECHECK_MINUTES||30)));

type AppointmentEvent="created"|"confirmed"|"cancelled"|"rescheduled"|"completed";
type Channel="email"|"sms";

function preferredChannels(a:any):Array<{channel:Channel;recipient:string}>{
  const preference=String(a.preferred_contact||"email").trim().toLowerCase();
  const email=String(a.email||"").trim();
  const phone=String(a.phone||"").trim();
  const emailEnabled=a.email_channel_enabled!==false;
  const smsEnabled=a.sms_channel_enabled===true;
  const result:Array<{channel:Channel;recipient:string}>=[];

  if(preference==="both"){
    if(emailEnabled&&email)result.push({channel:"email",recipient:email});
    if(smsEnabled&&phone)result.push({channel:"sms",recipient:phone});
  }else if(preference==="sms"){
    if(smsEnabled&&phone)result.push({channel:"sms",recipient:phone});
  }else if(emailEnabled&&email){
    result.push({channel:"email",recipient:email});
  }

  if(!result.length){
    if(emailEnabled&&email)result.push({channel:"email",recipient:email});
    else if(smsEnabled&&phone)result.push({channel:"sms",recipient:phone});
  }
  return result;
}

export async function queueAppointmentCommunications(appointmentId:string,event:AppointmentEvent){
  await ensureOnlineBooking();
  const {rows}=await db.query(`
    SELECT a.id,a.location_id,a.client_id,kleo_booking_utc(a.start_time) start_time,kleo_booking_utc(a.end_time) end_time,a.status,a.cancellation_token,
           COALESCE(c.full_name,c.name,'Vendég') client_name,c.email,c.phone,c.preferred_contact,
           COALESCE(e.full_name,e.name,'Szakember') employee_name,
           COALESCE(l.name,'Kleopátra Szalon') location_name,
           COALESCE(s.confirmation_enabled,true) confirmation_enabled,
           COALESCE(s.reminder_48h_enabled,true) reminder_48h_enabled,
           COALESCE(s.reminder_24h_enabled,true) reminder_24h_enabled,
           COALESCE(s.cancellation_enabled,true) cancellation_enabled,
           COALESCE(s.review_request_enabled,true) review_request_enabled,
           COALESCE(s.review_delay_hours,24) review_delay_hours,
           COALESCE(s.email_channel_enabled,true) email_channel_enabled,
           COALESCE(s.sms_channel_enabled,false) sms_channel_enabled
      FROM appointments a
      LEFT JOIN clients c ON c.id=a.client_id
      LEFT JOIN employees e ON e.id=a.employee_id
      LEFT JOIN locations l ON l.id=a.location_id
      LEFT JOIN booking_communication_settings s ON s.location_id=a.location_id
     WHERE a.id=$1::uuid LIMIT 1`,[appointmentId]);
  const a=rows[0];
  if(!a)return{queued:0,reason:"appointment_not_found"};
  const channels=preferredChannels(a);
  if(!channels.length)return{queued:0,reason:"no_reachable_channel"};
  let queued=0;

  const insert=async(eventType:string,scheduledAt:Date,subject:string,text:string)=>{
    if(scheduledAt.getTime()<Date.now()-60_000)return;
    for(const target of channels){
      const result=await db.query(`INSERT INTO booking_communication_queue
        (appointment_id,location_id,client_id,channel,event_type,recipient,subject,body_text,scheduled_at)
        VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9::timestamptz)
        ON CONFLICT DO NOTHING`,[a.id,a.location_id,a.client_id,target.channel,eventType,target.recipient,subject,text,scheduledAt.toISOString()]);
      queued+=result.rowCount||0;
    }
  };

  const where=`${a.location_name}, ${fmtDate(a.start_time)} ${fmtTime(a.start_time)}`;
  const publicBookingBase=String(process.env.PUBLIC_BOOKING_URL||"https://kleoszalon-frontend.onrender.com").replace(/\/$/,"");
  const manageLink=a.cancellation_token?`${publicBookingBase}/booking/manage/${a.cancellation_token}`:"";
  const manageText=manageLink?`Foglalás kezelése (módosítás / lemondás): ${manageLink}`:"";

  if(event==="created"&&a.confirmation_enabled){
    await insert("booking_created",new Date(),"Kleopátra Szalon – foglalási igény",`Kedves ${a.client_name}!\nFoglalási igényét rögzítettük.\n${where}\nSzakember: ${a.employee_name}\nStátusz: ${a.status}.\n${manageText}`);
  }
  if(event==="confirmed"&&a.confirmation_enabled){
    await insert("booking_confirmed",new Date(),"Kleopátra Szalon – időpont visszaigazolva",`Kedves ${a.client_name}!\nIdőpontját visszaigazoltuk.\n${where}\nSzakember: ${a.employee_name}.\n${manageText}`);
  }
  if(event==="rescheduled"&&a.confirmation_enabled){
    await insert("booking_rescheduled",new Date(),"Kleopátra Szalon – időpont módosult",`Kedves ${a.client_name}!\nIdőpontja módosult.\nÚj időpont: ${where}\nSzakember: ${a.employee_name}.\n${manageText}`);
  }
  if(event==="cancelled"&&a.cancellation_enabled){
    await db.query(`UPDATE booking_communication_queue SET status='cancelled',updated_at=now() WHERE appointment_id=$1::uuid AND status='pending'`,[a.id]);
    await insert("booking_cancelled",new Date(),"Kleopátra Szalon – időpont lemondva",`Kedves ${a.client_name}!\nA(z) ${where} időpontját lemondtuk.`);
  }
  if(event==="completed"&&a.review_request_enabled){
    await insert("review_request",new Date(Date.now()+Number(a.review_delay_hours||24)*3600_000),"Kleopátra Szalon – hogy érezte magát nálunk?",`Kedves ${a.client_name}!\nKöszönjük, hogy minket választott. Örömmel vesszük visszajelzését a látogatásáról.`);
  }
  if(["created","confirmed","rescheduled"].includes(event)){
    await db.query(`UPDATE booking_communication_queue SET status='cancelled',updated_at=now()
      WHERE appointment_id=$1::uuid AND event_type IN ('reminder_48h','reminder_24h') AND status='pending'`,[a.id]);
    const startMs=new Date(a.start_time).getTime();
    if(a.reminder_48h_enabled)await insert("reminder_48h",new Date(startMs-48*3600_000),"Kleopátra Szalon – emlékeztető az időpontjáról",`Kedves ${a.client_name}!\n48 óra múlva várjuk: ${where}.\nSzakember: ${a.employee_name}.\n${manageText}`);
    if(a.reminder_24h_enabled)await insert("reminder_24h",new Date(startMs-24*3600_000),"Kleopátra Szalon – holnap várjuk",`Kedves ${a.client_name}!\nHolnap várjuk: ${where}.\nSzakember: ${a.employee_name}.\n${manageText}`);
  }
  return{queued,channels:channels.map(x=>x.channel)};
}

export async function resolveRecoveredBookingCommunicationAuthFailures(){
  await ensureOnlineBooking();
  const emailTransport=await verifyEmailTransport();
  const {rows}=await db.query(`SELECT id,error_text,channel,recipient FROM booking_communication_queue
    WHERE status='failed' AND resolved_at IS NULL AND channel='email'`);

  const authIds=emailTransport.ok?rows
    .filter((row:any)=>classifyBookingCommunicationFailure(row.error_text,row.channel).key==="authentication")
    .map((row:any)=>String(row.id)):[];
  const missingRecipientIds=rows
    .filter((row:any)=>{
      const raw=stripBookingCommunicationRetryPrefix(row.error_text).toLowerCase();
      return !String(row.recipient||"").trim()||raw.includes("no recipients defined");
    })
    .map((row:any)=>String(row.id));

  let resolvedAuth=0,resolvedMissingRecipient=0;
  if(authIds.length){
    const result=await db.query(`UPDATE booking_communication_queue
      SET resolved_at=now(),resolution_code='smtp_auth_recovered',
          resolution_note='SMTP hitelesítés helyreállt; történeti infrastruktúra-incidens lezárva. Automatikus tömeges újraküldés nem történt.',
          updated_at=now()
      WHERE id = ANY($1::uuid[]) AND resolved_at IS NULL`,[authIds]);
    resolvedAuth=result.rowCount||0;
  }
  if(missingRecipientIds.length){
    const result=await db.query(`UPDATE booking_communication_queue
      SET resolved_at=now(),resolution_code='missing_recipient_historical',
          resolution_note='A történeti üzenethez nem volt címzett, ezért biztonságosan nem küldhető újra. Az eset adatminőségi hibaként lezárva.',
          updated_at=now()
      WHERE id = ANY($1::uuid[]) AND resolved_at IS NULL`,[missingRecipientIds]);
    resolvedMissingRecipient=result.rowCount||0;
  }

  return{resolved:resolvedAuth+resolvedMissingRecipient,resolved_auth:resolvedAuth,resolved_missing_recipient:resolvedMissingRecipient,email_transport:emailTransport};
}

export async function processDueBookingCommunications(limit=50){
  await ensureOnlineBooking();
  const emailTransport:EmailTransportHealth=await verifyEmailTransport();
  const cx=await db.connect();
  const summary={processed:0,sent:0,suppressed:0,provider_blocked:0,retry_scheduled:0,failed:0,email_transport:emailTransport};
  try{
    await cx.query("BEGIN");
    const {rows}=await cx.query(`SELECT * FROM booking_communication_queue
      WHERE status='pending' AND scheduled_at<=now()
      ORDER BY scheduled_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED`,[limit]);
    summary.processed=rows.length;
    for(const item of rows){
      if(!String(item.recipient||"").trim()){
        summary.suppressed+=1;
        await cx.query(`UPDATE booking_communication_queue
          SET status='suppressed',failed_at=NULL,error_text='Címzett hiányzik; küldés nem történt.',
              resolved_at=now(),resolution_code='missing_recipient',
              resolution_note='A tétel küldési próbálkozás nélkül suppressed állapotba került, mert nincs címzett.',updated_at=now()
          WHERE id=$1`,[item.id]);
        continue;
      }

      if(item.channel==="email"&&!emailTransport.ok){
        if(emailTransport.mode==="disabled"||emailTransport.mode==="unconfigured"){
          summary.suppressed+=1;
          await cx.query(`UPDATE booking_communication_queue
            SET status='suppressed',failed_at=NULL,error_text=$2,updated_at=now()
            WHERE id=$1`,[item.id,emailTransport.mode==="disabled"?"E-mail küldés szándékosan letiltva (SMTP disabled); üzenet nem került kiküldésre.":"E-mail szolgáltató nincs konfigurálva; üzenet suppressed állapotba került, kiküldés nem történt."]);
          continue;
        }

        summary.provider_blocked+=1;
        const nextRetry=new Date(Date.now()+PROVIDER_RECHECK_MINUTES*60_000).toISOString();
        await cx.query(`UPDATE booking_communication_queue
          SET status='pending',scheduled_at=$2::timestamptz,failed_at=NULL,error_text=$3,updated_at=now()
          WHERE id=$1`,[item.id,nextRetry,`SMTP előellenőrzés sikertelen (${emailTransport.error_code||"SMTP_VERIFY_FAILED"}); küldés nem történt, próbálkozás nem fogyott.`]);
        continue;
      }

      const attempt=Number(item.attempt_count||0)+1;
      await cx.query(`UPDATE booking_communication_queue SET status='processing',attempt_count=$2,updated_at=now() WHERE id=$1`,[item.id,attempt]);
      try{
        let result:any;
        if(item.channel==="email")result=await sendEmail({to:item.recipient,subject:item.subject,text:item.body_text,html:item.body_html||undefined});
        else if(item.channel==="sms")result=await sendSms({to:item.recipient,text:item.body_text});
        else throw new Error(`A ${item.channel} csatorna még nincs konfigurálva.`);
        if(result?.logged){
          summary.suppressed+=1;
          await cx.query(`UPDATE booking_communication_queue SET status='suppressed',failed_at=NULL,error_text=$2,updated_at=now() WHERE id=$1`,[item.id,`${item.channel} küldés szándékosan kihagyva: a szolgáltató letiltott vagy log-only módban van.`]);
        }else{
          summary.sent+=1;
          await cx.query(`UPDATE booking_communication_queue SET status='sent',sent_at=now(),failed_at=NULL,error_text=NULL,updated_at=now() WHERE id=$1`,[item.id]);
        }
      }catch(error:any){
        const message=error?.message||String(error);
        if(attempt<MAX_SEND_ATTEMPTS){
          summary.retry_scheduled+=1;
          const nextRetry=new Date(Date.now()+retryDelayMinutes(attempt)*60_000).toISOString();
          await cx.query(`UPDATE booking_communication_queue SET status='pending',scheduled_at=$2::timestamptz,failed_at=NULL,error_text=$3,updated_at=now() WHERE id=$1`,[item.id,nextRetry,`Küldési hiba, újrapróbálás ${attempt}/${MAX_SEND_ATTEMPTS}: ${message}`]);
        }else{
          summary.failed+=1;
          await cx.query(`UPDATE booking_communication_queue SET status='failed',failed_at=now(),error_text=$2,resolved_at=NULL,resolution_code=NULL,resolution_note=NULL,updated_at=now() WHERE id=$1`,[item.id,`Végleges küldési hiba ${attempt}/${MAX_SEND_ATTEMPTS}: ${message}`]);
        }
      }
    }
    await cx.query("COMMIT");
    return summary;
  }catch(error){await cx.query("ROLLBACK").catch(()=>undefined);throw error}finally{cx.release()}
}
