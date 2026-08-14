import { Router } from "express";
import * as https from "https";
import db from "../db";
import { requireAuth } from "../middleware/auth";
import { requireManagement } from "../middleware/requireRoles";
import { sendEmail } from "../mailer";
import { sendSms } from "../sms";

const router = Router();
const SITE_URL = String(process.env.PUBLIC_SITE_URL || process.env.WEBSITE_URL || "https://weblap-o3g6.onrender.com").replace(/\/$/, "");
const FRONTEND_URL = String(process.env.FRONTEND_URL || "https://kleoszalon-frontend.onrender.com").replace(/\/$/, "");
const LOGO_URL = `${FRONTEND_URL}/kleopatra-logo.png`;
const TYPES = new Set(["inactive", "birthday", "nameday", "empty_slots"]);
let ensurePromise: Promise<void> | null = null;
let schedulerBusy = false;

type Rule = {
  automation_type: string; enabled: boolean; run_hour: number; channels: string[];
  offer_text: string; subject_template: string; message_template: string; config: any; last_run_at?: string | null;
};
type Candidate = { id: string; name: string; email?: string | null; phone?: string | null; email_consent?: boolean; sms_consent?: boolean; location_id?: string | null; last_visit?: string | null; inactive_days?: number; birth_date?: string | null };

function budapestNow() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Budapest", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const o: Record<string,string> = {}; parts.forEach(p => { if (p.type !== "literal") o[p.type] = p.value; });
  return { date: `${o.year}-${o.month}-${o.day}`, year: Number(o.year), hour: Number(o.hour) };
}
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c] || c));
const clean = (s: unknown, max=2000) => String(s ?? "").trim().slice(0,max);
const uuid = (s: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s||""));
const normName = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("hu-HU").replace(/[^a-z]/g, "");

async function ensure() {
  if (ensurePromise) return ensurePromise;
  ensurePromise = db.query(`
    CREATE TABLE IF NOT EXISTS marketing_automation_rules(
      automation_type text PRIMARY KEY, enabled boolean NOT NULL DEFAULT false, run_hour int NOT NULL DEFAULT 9,
      channels jsonb NOT NULL DEFAULT '["email"]'::jsonb, offer_text text NOT NULL DEFAULT '',
      subject_template text NOT NULL DEFAULT '', message_template text NOT NULL DEFAULT '', config jsonb NOT NULL DEFAULT '{}'::jsonb,
      last_run_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS marketing_campaign_runs(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), campaign_type text NOT NULL, name text NOT NULL, source_key text UNIQUE NOT NULL,
      status text NOT NULL DEFAULT 'draft', audience_count int NOT NULL DEFAULT 0, sent_email int NOT NULL DEFAULT 0,
      sent_sms int NOT NULL DEFAULT 0, sent_push int NOT NULL DEFAULT 0, clicks int NOT NULL DEFAULT 0,
      manual_cost numeric(14,2) NOT NULL DEFAULT 0, metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS marketing_automation_deliveries(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid REFERENCES marketing_campaign_runs(id) ON DELETE CASCADE,
      automation_type text NOT NULL, segment_key text NOT NULL DEFAULT '', client_id text NOT NULL, cycle_key text NOT NULL,
      channel text NOT NULL, status text NOT NULL DEFAULT 'queued', error text, sent_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(automation_type,segment_key,client_id,cycle_key,channel));
    CREATE TABLE IF NOT EXISTS marketing_cost_settings(
      id int PRIMARY KEY DEFAULT 1, email_cost numeric(10,2) NOT NULL DEFAULT 2, sms_cost numeric(10,2) NOT NULL DEFAULT 28,
      push_cost numeric(10,2) NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), CHECK(id=1));
    INSERT INTO marketing_cost_settings(id) VALUES(1) ON CONFLICT(id) DO NOTHING;
    INSERT INTO marketing_automation_rules(automation_type,enabled,run_hour,channels,offer_text,subject_template,message_template,config) VALUES
      ('inactive',false,10,'["email"]','15% kedvezmény','Hiányzol a Kleopátrából ✨','Kedves {{nev}}! Már {{napok}} napja nem találkoztunk. Várunk vissza egy kis énidőre – most {{ajanlat}} vár rád.','{"segments":[30,60,90]}'::jsonb),
      ('birthday',false,9,'["email"]','20% születésnapi kedvezmény','Boldog születésnapot kíván a Kleopátra! 🎂','Kedves {{nev}}! Születésnapod alkalmából {{ajanlat}} ajándékkal várunk. Foglalj időpontot, és ünnepelj egy kis énidővel!','{"days_ahead":0}'::jsonb),
      ('nameday',false,9,'["email"]','20% névnapi kedvezmény','Boldog névnapot kíván a Kleopátra! 🌷','Kedves {{nev}}! Névnapod alkalmából {{ajanlat}} vár rád a Kleopátrában. Szeretettel várunk!','{}'::jsonb),
      ('empty_slots',false,8,'["email","app"]','15% last minute kedvezmény','Felszabadult néhány időpont ✨','Ma felszabadult néhány időpontunk. Használd ki a {{ajanlat}} ajánlatot, amíg elérhető!','{"target":"today","min_gap_minutes":60,"minimum_lead_minutes":180,"max_campaigns_per_day":3}'::jsonb)
    ON CONFLICT(automation_type) DO NOTHING;
    CREATE TABLE IF NOT EXISTS daily_action_campaigns(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL,headline text,description_html text,image_url text,
      cta_label text DEFAULT 'Foglalok',cta_url text DEFAULT '/foglalas',discount_text text,valid_from timestamptz,valid_until timestamptz,
      audience jsonb DEFAULT '{"type":"all"}'::jsonb,channels jsonb DEFAULT '["app"]'::jsonb,status text DEFAULT 'draft',
      recipient_count int DEFAULT 0,sent_email int DEFAULT 0,sent_sms int DEFAULT 0,sent_push int DEFAULT 0,
      created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
  `).then(() => undefined).catch(e => { ensurePromise = null; throw e; });
  return ensurePromise;
}

async function rule(type: string): Promise<Rule> {
  await ensure();
  const r = (await db.query(`SELECT automation_type,enabled,run_hour,channels,offer_text,subject_template,message_template,config,last_run_at FROM marketing_automation_rules WHERE automation_type=$1`,[type])).rows[0];
  if (!r) throw new Error("Ismeretlen marketing automatika.");
  r.channels = Array.isArray(r.channels) ? r.channels : [];
  return r;
}

async function getRun(type:string,name:string,sourceKey:string,metadata:any={}) {
  const q=await db.query(`INSERT INTO marketing_campaign_runs(campaign_type,name,source_key,status,metadata) VALUES($1,$2,$3,'running',$4::jsonb)
    ON CONFLICT(source_key) DO UPDATE SET metadata=marketing_campaign_runs.metadata||EXCLUDED.metadata RETURNING *`,[type,name,sourceKey,JSON.stringify(metadata)]);
  return q.rows[0];
}
function bookingUrl(runId:string,type:string){const u=new URL(`${SITE_URL}/foglalas`);u.searchParams.set("campaign_run_id",runId);u.searchParams.set("utm_source","kleopatra_automation");u.searchParams.set("utm_medium","crm");u.searchParams.set("utm_campaign",type);return u.toString()}
function branded(subject:string,message:string,cta:string){return `<div style="margin:0;background:#f5f0eb;padding:28px;font-family:Arial,sans-serif;color:#251a1f"><div style="max-width:680px;margin:auto;background:#fff;border-radius:18px;overflow:hidden;border:1px solid #e9ddd3"><div style="padding:22px;text-align:center;border-bottom:1px solid #eadfce"><img src="${LOGO_URL}" alt="Kleopátra" style="width:100%;max-width:390px;height:auto"></div><div style="padding:34px"><h1 style="font-family:Georgia,serif;color:#39251f">${esc(subject)}</h1><p style="font-size:16px;line-height:1.65">${esc(message)}</p><p><a href="${esc(cta)}" style="display:inline-block;background:#ec008c;color:white;text-decoration:none;padding:12px 20px;border-radius:9px;font-weight:bold">Időpontot foglalok</a></p></div><div style="background:#f4ebe3;padding:16px 34px;font-size:11px;color:#76665d">Kleopátra Szépségszalonok · marketing üzenet a korábbi hozzájárulás alapján.</div></div></div>`}
function fill(tpl:string,c:Candidate,r:Rule,extra:Record<string,string|number>={}){let out=tpl;const vals:any={nev:c.name,ajanlat:r.offer_text,...extra};for(const[k,v]of Object.entries(vals))out=out.replaceAll(`{{${k}}}`,String(v));return out}

async function deliver(run:any,type:string,segment:string,cycle:string,c:Candidate,r:Rule,extra:Record<string,string|number>={}) {
  const url=bookingUrl(run.id,type); let email=0,sms=0;
  for(const channel of r.channels){
    if(channel!=="email"&&channel!=="sms")continue;
    const exists=(await db.query(`SELECT status FROM marketing_automation_deliveries WHERE automation_type=$1 AND segment_key=$2 AND client_id=$3 AND cycle_key=$4 AND channel=$5`,[type,segment,String(c.id),cycle,channel])).rows[0];
    if(exists)continue;
    const inserted=(await db.query(`INSERT INTO marketing_automation_deliveries(run_id,automation_type,segment_key,client_id,cycle_key,channel,status) VALUES($1,$2,$3,$4,$5,$6,'queued') ON CONFLICT DO NOTHING RETURNING id`,[run.id,type,segment,String(c.id),cycle,channel])).rows[0];
    if(!inserted)continue;
    try{
      if(channel==="email"&&c.email&&c.email_consent){const subject=fill(r.subject_template,c,r,extra),message=fill(r.message_template,c,r,extra);await sendEmail({to:c.email,subject,text:message,html:branded(subject,message,url)});email=1;}
      else if(channel==="sms"&&c.phone&&c.sms_consent){await sendSms({to:c.phone,text:`Kleopátra: ${fill(r.message_template,c,r,extra)} Foglalás: ${url}`});sms=1;}
      else{await db.query(`UPDATE marketing_automation_deliveries SET status='skipped',error='Nincs csatorna-hozzájárulás' WHERE id=$1`,[inserted.id]);continue}
      await db.query(`UPDATE marketing_automation_deliveries SET status='sent',sent_at=now() WHERE id=$1`,[inserted.id]);
    }catch(e:any){await db.query(`UPDATE marketing_automation_deliveries SET status='failed',error=$2 WHERE id=$1`,[inserted.id,String(e?.message||e).slice(0,500)]);}
  }
  return {email,sms};
}

async function inactiveCandidates(segment:number):Promise<Candidate[]> {
  const next=segment===30?60:segment===60?90:null;
  const {rows}=await db.query(`WITH v AS(
    SELECT c.id::text id,COALESCE(NULLIF(c.full_name,''),NULLIF(c.name,''),'Vendég') name,c.email,c.phone,c.email_consent,c.sms_consent,c.location_id::text,
      COALESCE(MAX(a.start_time) FILTER(WHERE a.start_time<=now() AND lower(COALESCE(a.status,'')) NOT IN('cancelled','canceled','no_show')),c.altegio_last_visit,c.created_at) last_visit
    FROM clients c LEFT JOIN appointments a ON a.client_id::text=c.id::text
    WHERE COALESCE(c.is_active,true)=true AND COALESCE(c.marketing_consent,false)=true
    GROUP BY c.id,c.full_name,c.name,c.email,c.phone,c.email_consent,c.sms_consent,c.location_id,c.altegio_last_visit,c.created_at)
    SELECT *, (CURRENT_DATE-last_visit::date)::int inactive_days FROM v
    WHERE (CURRENT_DATE-last_visit::date)>=$1 AND ($2::int IS NULL OR (CURRENT_DATE-last_visit::date)<$2)
      AND ((NULLIF(email,'') IS NOT NULL AND COALESCE(email_consent,false)) OR (NULLIF(phone,'') IS NOT NULL AND COALESCE(sms_consent,false)))
    ORDER BY last_visit LIMIT 5000`,[segment,next]);
  return rows;
}
async function birthdayCandidates():Promise<Candidate[]> {const {rows}=await db.query(`SELECT c.id::text id,COALESCE(NULLIF(c.full_name,''),NULLIF(c.name,''),'Vendég') name,c.email,c.phone,c.email_consent,c.sms_consent,c.location_id::text,c.birth_date::text FROM clients c WHERE COALESCE(c.is_active,true)=true AND COALESCE(c.marketing_consent,false)=true AND c.birth_date IS NOT NULL AND EXTRACT(MONTH FROM c.birth_date)=EXTRACT(MONTH FROM (now() AT TIME ZONE 'Europe/Budapest')) AND EXTRACT(DAY FROM c.birth_date)=EXTRACT(DAY FROM (now() AT TIME ZONE 'Europe/Budapest')) AND ((NULLIF(c.email,'') IS NOT NULL AND COALESCE(c.email_consent,false)) OR (NULLIF(c.phone,'') IS NOT NULL AND COALESCE(c.sms_consent,false))) ORDER BY c.full_name LIMIT 5000`);return rows}
function httpsGet(url:string){return new Promise<string>((resolve,reject)=>{https.get(url,{headers:{"User-Agent":"kleoszalon-marketing/1.0",Accept:"application/json"}},r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>Number(r.statusCode||0)>=400?reject(new Error(`HTTP ${r.statusCode}`)):resolve(d))}).on("error",reject)})}
async function namedayNames(){try{const raw=JSON.parse(await httpsGet("https://nameday.abalin.net/api/V1/today?country=hu&timezone=Europe/Budapest"));const x=raw?.data?.namedays?.hu??raw?.namedays?.hu??raw?.nameday?.hu??"";return String(x).split(/[,;\/]+/).map(x=>x.trim()).filter(Boolean).slice(0,20)}catch{return[] as string[]}}
async function namedayCandidates(names:string[]):Promise<Candidate[]>{if(!names.length)return[];const wanted=new Set(names.map(normName));const {rows}=await db.query(`SELECT c.id::text id,COALESCE(NULLIF(c.full_name,''),NULLIF(c.name,''),'Vendég') name,c.email,c.phone,c.email_consent,c.sms_consent,c.location_id::text FROM clients c WHERE COALESCE(c.is_active,true)=true AND COALESCE(c.marketing_consent,false)=true AND ((NULLIF(c.email,'') IS NOT NULL AND COALESCE(c.email_consent,false)) OR (NULLIF(c.phone,'') IS NOT NULL AND COALESCE(c.sms_consent,false))) LIMIT 10000`);return rows.filter((c:any)=>String(c.name||"").split(/\s+/).some((w:string)=>wanted.has(normName(w))))}

async function emptySlots(date:string,minGap=60,minLead=180){
  const locs=(await db.query(`SELECT l.id::text id,l.name,COALESCE(obs.opening_minute,480)::int opening_minute,COALESCE(obs.closing_minute,1200)::int closing_minute FROM locations l LEFT JOIN online_booking_settings obs ON obs.location_id=l.id WHERE COALESCE(l.is_active,true)=true ORDER BY l.name`)).rows;
  const out:any[]=[];
  for(const loc of locs){
    const emps=(await db.query(`SELECT id::text id,COALESCE(NULLIF(full_name,''),NULLIF(concat_ws(' ',last_name,first_name),''),'Munkatárs') name FROM employees WHERE COALESCE(active,true)=true AND location_id::text=$1 ORDER BY 2`,[loc.id])).rows;if(!emps.length)continue;
    const bounds=(await db.query(`SELECT (($1::date+$2::int*interval '1 minute') AT TIME ZONE 'Europe/Budapest') open_at,(($1::date+$3::int*interval '1 minute') AT TIME ZONE 'Europe/Budapest') close_at`,[date,loc.opening_minute,loc.closing_minute])).rows[0];
    const busy=(await db.query(`SELECT employee_id::text,start_time,end_time FROM appointments WHERE location_id::text=$1 AND employee_id=ANY($2::uuid[]) AND lower(COALESCE(status,'')) NOT IN('cancelled','canceled','no_show') AND start_time<$4::timestamptz AND end_time>$3::timestamptz ORDER BY start_time`,[loc.id,emps.map((e:any)=>e.id),bounds.open_at,bounds.close_at])).rows;
    for(const e of emps){let cursor=new Date(bounds.open_at);const close=new Date(bounds.close_at);const blocks=busy.filter((b:any)=>b.employee_id===e.id).map((b:any)=>({s:new Date(b.start_time),e:new Date(b.end_time)}));for(const b of blocks){if(b.s>cursor){const mins=(b.s.getTime()-cursor.getTime())/60000;if(mins>=minGap&&cursor.getTime()>Date.now()+minLead*60000)out.push({location_id:loc.id,location_name:loc.name,employee_id:e.id,employee_name:e.name,start:cursor.toISOString(),end:b.s.toISOString(),minutes:Math.round(mins)})}if(b.e>cursor)cursor=b.e}if(cursor<close){const mins=(close.getTime()-cursor.getTime())/60000;if(mins>=minGap&&cursor.getTime()>Date.now()+minLead*60000)out.push({location_id:loc.id,location_name:loc.name,employee_id:e.id,employee_name:e.name,start:cursor.toISOString(),end:close.toISOString(),minutes:Math.round(mins)})}}
  }
  return out.sort((a,b)=>a.start.localeCompare(b.start));
}
async function locationCandidates(locationId:string):Promise<Candidate[]>{const {rows}=await db.query(`SELECT id::text id,COALESCE(NULLIF(full_name,''),NULLIF(name,''),'Vendég') name,email,phone,email_consent,sms_consent,location_id::text FROM clients WHERE location_id::text=$1 AND COALESCE(is_active,true)=true AND COALESCE(marketing_consent,false)=true AND ((NULLIF(email,'') IS NOT NULL AND COALESCE(email_consent,false)) OR (NULLIF(phone,'') IS NOT NULL AND COALESCE(sms_consent,false))) LIMIT 5000`,[locationId]);return rows}

async function runInactive(r:Rule){const now=budapestNow(),results:any[]=[];for(const segment of (r.config?.segments||[30,60,90]).map(Number).filter((n:number)=>[30,60,90].includes(n))){const candidates=await inactiveCandidates(segment),run=await getRun("inactive",`${segment} napos visszahívó kampány`,`inactive:${now.date}:${segment}`,{segment});let email=0,sms=0;for(const c of candidates){const cycle=String(c.last_visit||"never").slice(0,10);const x=await deliver(run,"inactive",String(segment),cycle,c,r,{napok:c.inactive_days||segment});email+=x.email;sms+=x.sms}await db.query(`UPDATE marketing_campaign_runs SET status='completed',audience_count=$2,sent_email=$3,sent_sms=$4,finished_at=now() WHERE id=$1`,[run.id,candidates.length,email,sms]);results.push({run_id:run.id,segment,audience:candidates.length,email,sms})}return results}
async function runOccasion(type:"birthday"|"nameday",r:Rule){const now=budapestNow();const names=type==="nameday"?await namedayNames():[];const candidates=type==="birthday"?await birthdayCandidates():await namedayCandidates(names);const run=await getRun(type,type==="birthday"?"Születésnapi automatika":`Névnapi automatika${names[0]?` – ${names[0]}`:""}`,`${type}:${now.date}`,{names});let email=0,sms=0;for(const c of candidates){const x=await deliver(run,type,"",String(now.year),c,r);email+=x.email;sms+=x.sms}await db.query(`UPDATE marketing_campaign_runs SET status='completed',audience_count=$2,sent_email=$3,sent_sms=$4,finished_at=now() WHERE id=$1`,[run.id,candidates.length,email,sms]);return{run_id:run.id,names,audience:candidates.length,email,sms}}
async function runEmpty(r:Rule){const now=budapestNow(),target=r.config?.target==="tomorrow"?new Date(Date.now()+86400000):new Date(),date=new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Budapest"}).format(target),slots=await emptySlots(date,Number(r.config?.min_gap_minutes||60),Number(r.config?.minimum_lead_minutes||180)),group=new Map<string,any[]>();slots.forEach(s=>group.set(s.location_id,[...(group.get(s.location_id)||[]),s]));const results:any[]=[];for(const[locationId,all]of group){const chosen=all.slice(0,Number(r.config?.max_campaigns_per_day||3));if(!chosen.length)continue;const source=`empty:${date}:${locationId}`,run=await getRun("empty_slots",`Last minute időpontok – ${chosen[0].location_name}`,source,{date,slots:chosen});if(run.status==="completed"){results.push({run_id:run.id,location:chosen[0].location_name,skipped:true});continue}const times=chosen.map(s=>`${new Date(s.start).toLocaleTimeString("hu-HU",{timeZone:"Europe/Budapest",hour:"2-digit",minute:"2-digit"})} – ${s.employee_name}`).join("<br>");const cta=bookingUrl(run.id,"empty_slots");await db.query(`INSERT INTO daily_action_campaigns(name,headline,description_html,cta_label,cta_url,discount_text,valid_from,valid_until,audience,channels,status,updated_at) VALUES($1,$2,$3,'Foglalok',$4,$5,now(),(($6::date+interval '1 day') AT TIME ZONE 'Europe/Budapest'),$7::jsonb,'["app"]'::jsonb,'published',now())`,[`Automata last minute – ${chosen[0].location_name} – ${date}`,"Felszabadult néhány időpont ✨",`<p>${esc(r.offer_text)}</p><p>${times}</p>`,cta,r.offer_text,date,JSON.stringify({type:"location",location_id:locationId})]);const candidates=await locationCandidates(locationId);let email=0,sms=0;for(const c of candidates){const x=await deliver(run,"empty_slots",locationId,date,c,r,{idopontok:chosen.map(s=>s.start).join(",")});email+=x.email;sms+=x.sms}await db.query(`UPDATE marketing_campaign_runs SET status='completed',audience_count=$2,sent_email=$3,sent_sms=$4,finished_at=now() WHERE id=$1`,[run.id,candidates.length,email,sms]);results.push({run_id:run.id,location:chosen[0].location_name,slots:chosen.length,audience:candidates.length,email,sms})}return{date,slot_count:slots.length,results}}
async function runType(type:string){const r=await rule(type);if(type==="inactive")return runInactive(r);if(type==="birthday"||type==="nameday")return runOccasion(type as any,r);if(type==="empty_slots")return runEmpty(r);throw new Error("Ismeretlen automatika")}

async function roi(from:string,to:string){await ensure();const runs=(await db.query(`SELECT r.*,COALESCE(conv.conversions,0)::int conversions,COALESCE(conv.booked_value,0)::numeric booked_value,COALESCE(pay.revenue,0)::numeric revenue FROM marketing_campaign_runs r
  LEFT JOIN LATERAL(SELECT COUNT(DISTINCT a.id)::int conversions,COALESCE(SUM(aps.net),0)::numeric booked_value FROM appointments a LEFT JOIN LATERAL(SELECT COALESCE(SUM(price*(1-COALESCE(discount_percent,0)/100.0)),0)::numeric net FROM appointment_services WHERE appointment_id=a.id)aps ON true WHERE lower(COALESCE(a.status,'')) NOT IN('cancelled','canceled','no_show') AND COALESCE(a.notes,'') LIKE ('%[campaign:'||r.id::text||']%'))conv ON true
  LEFT JOIN LATERAL(SELECT COALESCE(SUM(wp.amount),0)::numeric revenue FROM appointments a JOIN work_order_payments wp ON wp.work_order_id::text=(to_jsonb(a)->>'work_order_id') WHERE COALESCE(a.notes,'') LIKE ('%[campaign:'||r.id::text||']%'))pay ON true
  WHERE r.created_at>=$1::date AND r.created_at<($2::date+interval '1 day') ORDER BY r.created_at DESC`,[from,to])).rows;
  const costs=(await db.query(`SELECT * FROM marketing_cost_settings WHERE id=1`)).rows[0]||{email_cost:2,sms_cost:28,push_cost:0};for(const x of runs){x.estimated_cost=Number(x.manual_cost||0)+Number(x.sent_email||0)*Number(costs.email_cost||0)+Number(x.sent_sms||0)*Number(costs.sms_cost||0)+Number(x.sent_push||0)*Number(costs.push_cost||0);x.roi_percent=x.estimated_cost>0?((Number(x.revenue||0)-x.estimated_cost)/x.estimated_cost)*100:null;x.conversion_rate=Number(x.audience_count||0)>0?Number(x.conversions||0)/Number(x.audience_count)*100:0}
  const newsletters=await db.query(`SELECT id::text,name,'newsletter' campaign_type,status,COALESCE(recipient_count,0)::int audience_count,COALESCE(sent_count,0)::int sent_count,sent_at,created_at FROM newsletter_campaigns WHERE created_at>=$1::date AND created_at<($2::date+interval '1 day') ORDER BY created_at DESC`,[from,to]).then(x=>x.rows).catch(()=>[]);
  const daily=await db.query(`SELECT id::text,name,'daily_action' campaign_type,status,COALESCE(recipient_count,0)::int audience_count,(COALESCE(sent_email,0)+COALESCE(sent_sms,0)+COALESCE(sent_push,0))::int sent_count,created_at FROM daily_action_campaigns WHERE created_at>=$1::date AND created_at<($2::date+interval '1 day') ORDER BY created_at DESC`,[from,to]).then(x=>x.rows).catch(()=>[]);
  const summary=runs.reduce((a:any,x:any)=>{a.campaigns++;a.audience+=Number(x.audience_count||0);a.sent+=Number(x.sent_email||0)+Number(x.sent_sms||0)+Number(x.sent_push||0);a.conversions+=Number(x.conversions||0);a.booked_value+=Number(x.booked_value||0);a.revenue+=Number(x.revenue||0);a.cost+=Number(x.estimated_cost||0);return a},{campaigns:0,audience:0,sent:0,conversions:0,booked_value:0,revenue:0,cost:0});summary.roi_percent=summary.cost>0?((summary.revenue-summary.cost)/summary.cost)*100:null;return{from,to,cost_settings:costs,summary,runs,legacy:{newsletters,daily_actions:daily}}
}

router.use(requireAuth,requireManagement);
router.use(async(_req,_res,next)=>{try{await ensure();next()}catch(e){next(e)}});
router.get("/overview",async(_req,res,next)=>{try{const rules=(await db.query(`SELECT * FROM marketing_automation_rules ORDER BY automation_type`)).rows;const today=budapestNow().date;const [c30,c60,c90,birth,names,slots]=await Promise.all([inactiveCandidates(30),inactiveCandidates(60),inactiveCandidates(90),birthdayCandidates(),namedayNames(),emptySlots(today,60,180)]);const named=await namedayCandidates(names);res.json({rules,preview:{inactive:{30:c30.length,60:c60.length,90:c90.length},birthday:birth.length,nameday:{names,count:named.length},empty_slots:slots.length}})}catch(e){next(e)}});
router.get("/preview/:type",async(req,res,next)=>{try{const type=String(req.params.type);if(!TYPES.has(type))return res.status(404).json({message:"Ismeretlen automatika."});if(type==="inactive"){const data:any={};for(const n of[30,60,90]){const x=await inactiveCandidates(n);data[n]={count:x.length,sample:x.slice(0,10)}}return res.json(data)}if(type==="birthday"){const x=await birthdayCandidates();return res.json({count:x.length,sample:x.slice(0,20)})}if(type==="nameday"){const names=await namedayNames(),x=await namedayCandidates(names);return res.json({names,count:x.length,sample:x.slice(0,20)})}const r=await rule("empty_slots"),date=req.query.date?String(req.query.date):budapestNow().date,x=await emptySlots(date,Number(req.query.min_gap||r.config?.min_gap_minutes||60),Number(r.config?.minimum_lead_minutes||180));return res.json({date,count:x.length,slots:x.slice(0,100)})}catch(e){next(e)}});
router.patch("/rules/:type",async(req,res,next)=>{try{const type=String(req.params.type);if(!TYPES.has(type))return res.status(404).json({message:"Ismeretlen automatika."});const cur=await rule(type),b=req.body||{};const channels=Array.isArray(b.channels)?Array.from(new Set(b.channels.map(String).filter((x:string)=>["email","sms","app"].includes(x)))):cur.channels;const config={...(cur.config||{}),...(b.config||{})};const q=await db.query(`UPDATE marketing_automation_rules SET enabled=$2,run_hour=$3,channels=$4::jsonb,offer_text=$5,subject_template=$6,message_template=$7,config=$8::jsonb,updated_at=now() WHERE automation_type=$1 RETURNING *`,[type,b.enabled===undefined?cur.enabled:Boolean(b.enabled),Math.max(0,Math.min(23,Number(b.run_hour??cur.run_hour)||0)),JSON.stringify(channels),clean(b.offer_text??cur.offer_text,500),clean(b.subject_template??cur.subject_template,500),clean(b.message_template??cur.message_template,3000),JSON.stringify(config)]);res.json(q.rows[0])}catch(e){next(e)}});
router.post("/run/:type",async(req,res,next)=>{try{const type=String(req.params.type);if(!TYPES.has(type))return res.status(404).json({message:"Ismeretlen automatika."});const result=await runType(type);await db.query(`UPDATE marketing_automation_rules SET last_run_at=now(),updated_at=now() WHERE automation_type=$1`,[type]);res.json({ok:true,type,result})}catch(e){next(e)}});
router.get("/roi",async(req,res,next)=>{try{const today=budapestNow().date,from=/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from||""))?String(req.query.from):`${today.slice(0,8)}01`,to=/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to||""))?String(req.query.to):today;res.json(await roi(from,to))}catch(e){next(e)}});
router.put("/roi/cost-settings",async(req,res,next)=>{try{const b=req.body||{},q=await db.query(`UPDATE marketing_cost_settings SET email_cost=$1,sms_cost=$2,push_cost=$3,updated_at=now() WHERE id=1 RETURNING *`,[Math.max(0,Number(b.email_cost)||0),Math.max(0,Number(b.sms_cost)||0),Math.max(0,Number(b.push_cost)||0)]);res.json(q.rows[0])}catch(e){next(e)}});

async function scheduler(){if(schedulerBusy)return;schedulerBusy=true;try{await ensure();const now=budapestNow(),rules=(await db.query(`SELECT * FROM marketing_automation_rules WHERE enabled=true AND run_hour=$1`,[now.hour])).rows;for(const r of rules){const last=r.last_run_at?new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Budapest"}).format(new Date(r.last_run_at)):"";if(last===now.date)continue;try{await runType(r.automation_type);await db.query(`UPDATE marketing_automation_rules SET last_run_at=now(),updated_at=now() WHERE automation_type=$1`,[r.automation_type])}catch(e:any){console.warn("[marketing-automation]",r.automation_type,e?.message||e)}}}catch(e:any){console.warn("[marketing-automation-scheduler]",e?.message||e)}finally{schedulerBusy=false}}
const timer=setInterval(()=>void scheduler(),60*60*1000);timer.unref();setTimeout(()=>void scheduler(),90_000).unref();

export default router;
