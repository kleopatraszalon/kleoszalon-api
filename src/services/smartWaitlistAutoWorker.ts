import db from "../db";
import ensureOnlineBooking from "../booking/ensureOnlineBooking";
import { sendEmail } from "../mailer";
import { sendSms } from "../sms";
import { candidateRows, ensureSmartWaitlistSchema } from "../routes/bookingSmartWaitlist";

const SCAN_MS=Math.max(30_000,Number(process.env.SMART_WAITLIST_SCAN_MS||60_000));
const INITIAL_DELAY_MS=Math.max(5_000,Number(process.env.SMART_WAITLIST_INITIAL_DELAY_MS||15_000));
const OFFER_MINUTES=Math.max(5,Math.min(120,Number(process.env.SMART_WAITLIST_OFFER_MINUTES||15)));
const LIMIT=Math.max(1,Math.min(50,Number(process.env.SMART_WAITLIST_BATCH_LIMIT||20)));
const globalKey="__kleoSmartWaitlistAutoWorkerStarted";

const fmt=(value:any)=>new Intl.DateTimeFormat("hu-HU",{
  dateStyle:"medium",timeStyle:"short",timeZone:"Europe/Budapest"
}).format(new Date(value));

async function expireAndReopen(){
  await db.query(`UPDATE smart_waitlist_offers
    SET status='expired',responded_at=COALESCE(responded_at,now())
    WHERE status='pending' AND expires_at<=now()`);
  await db.query(`UPDATE booking_waitlist w SET status='waiting',updated_at=now()
    WHERE w.status='contacted' AND w.booked_appointment_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM smart_waitlist_offers o WHERE o.waitlist_id=w.id AND o.status='pending' AND o.expires_at>now())`);
  await db.query(`UPDATE smart_waitlist_vacancies v SET status='open',updated_at=now()
    WHERE v.status='offered' AND v.end_time>now()
      AND NOT EXISTS(SELECT 1 FROM smart_waitlist_offers o WHERE o.vacancy_id=v.id AND o.status='pending' AND o.expires_at>now())`);
  await db.query(`UPDATE smart_waitlist_vacancies SET status='expired',updated_at=now()
    WHERE status IN ('open','offered') AND end_time<=now()`);
}

async function sendOffer(offer:any,candidate:any,vacancy:any){
  const channel=String(offer.notification_channel||"");
  const text=`Kedves ${candidate.client_name}! Felszabadult egy időpont a Kleopátra Szalonban: ${fmt(vacancy.start_time)}, ${vacancy.location_name||"szalon"}, ${candidate.service_names||"kért szolgáltatás"}. Az ajánlat ${OFFER_MINUTES} percig él. Kérjük, jelezzen vissza a szalonnak.`;
  try{
    if(channel==="sms"&&candidate.phone)await sendSms({to:String(candidate.phone),text});
    else if(candidate.email)await sendEmail({to:String(candidate.email),subject:"Kleopátra Szalon – felszabadult időpont",text});
    else throw new Error("A vendéghez nincs használható elérhetőség.");
    await db.query(`UPDATE smart_waitlist_offers SET notification_status='sent',notification_error=NULL WHERE id=$1::uuid`,[offer.id]);
  }catch(error:any){
    await db.query(`UPDATE smart_waitlist_offers SET notification_status='failed',notification_error=$2 WHERE id=$1::uuid`,[offer.id,error?.message||String(error)]);
  }
}

async function processVacancy(vacancyId:string){
  const cx=await db.connect();
  let offer:any=null,candidate:any=null,vacancy:any=null;
  try{
    await cx.query("BEGIN");
    const lock=(await cx.query(`SELECT pg_try_advisory_xact_lock(hashtext($1)) locked`,[`smart-waitlist-auto:${vacancyId}`])).rows[0]?.locked;
    if(!lock){await cx.query("ROLLBACK");return false;}
    vacancy=(await cx.query(`SELECT v.*,COALESCE(l.name,'') location_name FROM smart_waitlist_vacancies v LEFT JOIN locations l ON l.id=v.location_id
      WHERE v.id=$1::uuid AND v.status='open' AND v.start_time>now() AND v.end_time>now() FOR UPDATE OF v`,[vacancyId])).rows[0];
    if(!vacancy){await cx.query("ROLLBACK");return false;}
    const active=(await cx.query(`SELECT 1 FROM smart_waitlist_offers WHERE vacancy_id=$1::uuid AND status='pending' AND expires_at>now() LIMIT 1`,[vacancyId])).rowCount;
    if(active){await cx.query("ROLLBACK");return false;}

    const ranked=await candidateRows(vacancyId,cx);
    if(!ranked.candidates.length){await cx.query("ROLLBACK");return false;}
    const offered=(await cx.query(`SELECT waitlist_id::text FROM smart_waitlist_offers WHERE vacancy_id=$1::uuid`,[vacancyId])).rows.map((x:any)=>String(x.waitlist_id));
    const offeredSet=new Set(offered);
    candidate=ranked.candidates.find((x:any)=>x.auto_offer!==false&&!offeredSet.has(String(x.id))&&(String(x.phone||"").trim()||String(x.email||"").trim()));
    if(!candidate){await cx.query("ROLLBACK");return false;}

    const expiresAt=new Date(Date.now()+OFFER_MINUTES*60_000).toISOString();
    const channel=String(candidate.phone||"").trim()?"sms":"email";
    offer=(await cx.query(`INSERT INTO smart_waitlist_offers(
        vacancy_id,waitlist_id,score,score_breakdown,expires_at,notification_channel,notification_status,created_by
      ) VALUES($1::uuid,$2::uuid,$3,$4::jsonb,$5::timestamptz,$6,'queued','smart-waitlist-auto') RETURNING *`,[
      vacancyId,candidate.id,candidate.score,JSON.stringify(candidate.score_breakdown||{}),expiresAt,channel
    ])).rows[0];
    await cx.query(`UPDATE booking_waitlist SET status='contacted',last_offered_at=now(),offer_count=offer_count+1,updated_at=now() WHERE id=$1::uuid`,[candidate.id]);
    await cx.query(`UPDATE smart_waitlist_vacancies SET status='offered',updated_at=now() WHERE id=$1::uuid`,[vacancyId]);
    await cx.query("COMMIT");
  }catch(error){await cx.query("ROLLBACK").catch(()=>undefined);throw error}finally{cx.release()}
  if(offer&&candidate&&vacancy)await sendOffer(offer,candidate,vacancy);
  return Boolean(offer);
}

export async function runSmartWaitlistAutoCycle(){
  await ensureOnlineBooking();
  await ensureSmartWaitlistSchema();
  await expireAndReopen();
  const {rows}=await db.query(`SELECT id::text FROM smart_waitlist_vacancies
    WHERE status='open' AND start_time>now() AND end_time>now()
    ORDER BY start_time,created_at LIMIT $1`,[LIMIT]);
  let offered=0;
  for(const row of rows){
    try{if(await processVacancy(String(row.id)))offered+=1}
    catch(error:any){console.error("[smart-waitlist-auto] vacancy failed",{vacancy_id:row.id,error:error?.message||String(error)})}
  }
  return{scanned:rows.length,offered};
}

export function startSmartWaitlistAutoWorker(){
  const g:any=globalThis as any;
  if(g[globalKey])return;
  g[globalKey]=true;
  const tick=async()=>{
    try{await runSmartWaitlistAutoCycle()}
    catch(error:any){console.error("[smart-waitlist-auto] cycle failed",error?.message||error)}
    const timer=setTimeout(tick,SCAN_MS);(timer as any).unref?.();
  };
  const timer=setTimeout(tick,INITIAL_DELAY_MS);(timer as any).unref?.();
}

export default startSmartWaitlistAutoWorker;
