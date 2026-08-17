import db from "../db";
import { sendEmail } from "../mailer";

const MAX_ATTEMPTS=5;
const BACKOFF_MINUTES=[5,15,60,240,720];

type QueueRow={id:string;tenant_id:string;subscription_id:string|null;notification_type:string;recipient_email:string|null;subject:string;payload:any;attempts:number;};

function bodyFor(row:QueueRow){
  const payload=row.payload&&typeof row.payload==="object"?row.payload:{};
  const tenantName=String(payload.tenant_name||"KleoSaaS ügyfél");
  const reason=String(payload.reason||"Előfizetési életciklus esemény történt.");
  if(row.notification_type==="trial_warning")return `${tenantName}\n\n${reason}\n\nKérjük, ellenőrizze az előfizetését a KleoSaaS felületén.`;
  if(row.notification_type==="trial_grace")return `${tenantName}\n\n${reason}\n\nA szolgáltatás türelmi időszakban van. Kérjük, rendezze vagy aktiválja az előfizetést.`;
  return `${tenantName}\n\n${reason}\n\nA szolgáltatás felfüggesztést igényelhet. Kérjük, ellenőrizze az előfizetés állapotát.`;
}

async function processOne(){
  const client=await db.connect();
  try{
    await client.query("BEGIN");
    const locked=await client.query(`SELECT id::text,tenant_id::text,subscription_id::text,notification_type,recipient_email,subject,payload,attempts
      FROM saas_lifecycle_notification_queue
      WHERE status='pending' AND next_attempt_at<=now()
      ORDER BY created_at,id
      FOR UPDATE SKIP LOCKED LIMIT 1`);
    const row=locked.rows[0] as QueueRow|undefined;
    if(!row){await client.query("COMMIT");return null;}
    const nextAttempt=Number(row.attempts||0)+1;
    if(!row.recipient_email){
      await client.query(`UPDATE saas_lifecycle_notification_queue SET status='failed',attempts=$2,last_error='MISSING_RECIPIENT',updated_at=now() WHERE id=$1::bigint`,[row.id,nextAttempt]);
      await client.query("COMMIT");
      return{queue_id:row.id,status:"failed",error:"MISSING_RECIPIENT"};
    }
    try{
      const text=bodyFor(row);
      const result=await sendEmail({to:row.recipient_email,subject:row.subject,text,html:`<p>${text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\n/g,"<br/>")}</p>`});
      if(!result?.sent){
        const terminal=nextAttempt>=MAX_ATTEMPTS;
        const backoff=BACKOFF_MINUTES[Math.min(nextAttempt-1,BACKOFF_MINUTES.length-1)];
        await client.query(`UPDATE saas_lifecycle_notification_queue SET status=$2,attempts=$3,next_attempt_at=now()+($4::int*interval '1 minute'),last_error='SMTP_NOT_SENT',updated_at=now() WHERE id=$1::bigint`,[row.id,terminal?'failed':'pending',nextAttempt,backoff]);
        await client.query("COMMIT");
        return{queue_id:row.id,status:terminal?'failed':'retry',error:'SMTP_NOT_SENT'};
      }
      await client.query(`UPDATE saas_lifecycle_notification_queue SET status='sent',attempts=$2,sent_at=now(),last_error=NULL,updated_at=now() WHERE id=$1::bigint`,[row.id,nextAttempt]);
      await client.query("COMMIT");
      return{queue_id:row.id,status:"sent",message_id:(result as any)?.messageId||null};
    }catch(error:any){
      const terminal=nextAttempt>=MAX_ATTEMPTS;
      const backoff=BACKOFF_MINUTES[Math.min(nextAttempt-1,BACKOFF_MINUTES.length-1)];
      await client.query(`UPDATE saas_lifecycle_notification_queue SET status=$2,attempts=$3,next_attempt_at=now()+($4::int*interval '1 minute'),last_error=$5,updated_at=now() WHERE id=$1::bigint`,[row.id,terminal?'failed':'pending',nextAttempt,backoff,String(error?.message||error||'MAIL_SEND_FAILED').slice(0,1000)]);
      await client.query("COMMIT");
      return{queue_id:row.id,status:terminal?'failed':'retry',error:String(error?.message||'MAIL_SEND_FAILED')};
    }
  }catch(error){await client.query("ROLLBACK").catch(()=>{});throw error;}finally{client.release();}
}

export async function processLifecycleNotificationQueue(limit=10){
  const bounded=Math.max(1,Math.min(25,Number(limit)||10));
  const results:any[]=[];
  for(let i=0;i<bounded;i++){const result=await processOne();if(!result)break;results.push(result);}
  return{processed_count:results.length,sent_count:results.filter(x=>x.status==='sent').length,retry_count:results.filter(x=>x.status==='retry').length,failed_count:results.filter(x=>x.status==='failed').length,results};
}
