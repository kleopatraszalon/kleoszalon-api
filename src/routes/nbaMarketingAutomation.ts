import { Router, Response, NextFunction } from "express";
import pool from "../db";
import { requireAuth } from "../middleware/auth";
import { requireTenantContext, TenantAuthRequest } from "../middleware/tenantContext";
import { sendEmail } from "../mailer";
import { sendSms } from "../sms";

const router = Router();
const SITE_URL = String(process.env.PUBLIC_SITE_URL || process.env.WEBSITE_URL || "https://weblap-o3g6.onrender.com").replace(/\/$/, "");
const MANAGEMENT_ROLES = new Set(["admin","administrator","rendszergazda","superadmin","super_admin","manager","vezető","vezeto","location_manager","salon_manager","szalonvezető","szalonvezeto","üzletvezető","uzletvezeto"]);
const CHANNELS = new Set(["email","sms","push","callback"]);
const MARKETING_ACTIONS = new Set(["FIRST_VISIT","WIN_BACK_60","REBOOK_30","VIP_RETENTION","BIRTHDAY_OFFER","CROSS_SELL","RELATIONSHIP_MAINTENANCE"]);
const JOB_STATUSES = new Set(["draft","approved","queued","ready","waiting_provider","sent","completed","cancelled","failed","blocked"]);
let schemaPromise: Promise<void> | null = null;
let schedulerBusy = false;

type Channel = "email"|"sms"|"push"|"callback";
type ClientContact = { id:string; name:string; email:string|null; phone:string|null; marketing_consent:boolean; email_consent:boolean; sms_consent:boolean; phone_consent:boolean; location_id:string|null };

function roles(raw:unknown){if(Array.isArray(raw))return raw.map(String).map(x=>x.toLowerCase());const text=String(raw??"");try{const parsed=JSON.parse(text);if(Array.isArray(parsed))return parsed.map(String).map(x=>x.toLowerCase())}catch{}return text.split(",").map(x=>x.replace(/[\[\]"]/g,"").trim().toLowerCase()).filter(Boolean)}
function requireManagement(req:TenantAuthRequest,res:Response,next:NextFunction){if(!roles(req.user?.role).some(r=>MANAGEMENT_ROLES.has(r)))return res.status(403).json({ok:false,code:"NBA_MARKETING_FORBIDDEN",error:"Ehhez a funkcióhoz vezetői jogosultság szükséges."});return next()}
const actor=(req:TenantAuthRequest)=>String(req.user?.id||req.user?.email||"")||null;
const clean=(value:unknown,max=3000)=>String(value??"").trim().slice(0,max);

async function ensureSchema(){if(schemaPromise)return schemaPromise;schemaPromise=pool.query(`
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE TABLE IF NOT EXISTS crm_nba_marketing_settings(
    tenant_id bigint PRIMARY KEY,
    auto_dispatch boolean NOT NULL DEFAULT false,
    require_explicit_approval boolean NOT NULL DEFAULT true,
    default_channel text NOT NULL DEFAULT 'email',
    max_daily_dispatch integer NOT NULL DEFAULT 100 CHECK(max_daily_dispatch BETWEEN 1 AND 5000),
    updated_by text,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS crm_nba_marketing_jobs(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id bigint NOT NULL,
    client_id text NOT NULL,
    nba_event_id uuid NOT NULL,
    action_code text NOT NULL,
    recommendation_version text NOT NULL DEFAULT 'nba-v1',
    channel text NOT NULL CHECK(channel IN('email','sms','push','callback')),
    status text NOT NULL DEFAULT 'draft' CHECK(status IN('draft','approved','queued','ready','waiting_provider','sent','completed','cancelled','failed','blocked')),
    subject text,
    message text NOT NULL,
    scheduled_at timestamptz,
    consent_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
    recommendation_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
    attribution_key text NOT NULL UNIQUE,
    error text,
    approved_by text,
    approved_at timestamptz,
    sent_at timestamptz,
    completed_at timestamptz,
    created_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(tenant_id,nba_event_id,channel)
  );
  CREATE INDEX IF NOT EXISTS crm_nba_marketing_jobs_tenant_status_idx ON crm_nba_marketing_jobs(tenant_id,status,created_at DESC);
  CREATE INDEX IF NOT EXISTS crm_nba_marketing_jobs_client_idx ON crm_nba_marketing_jobs(tenant_id,client_id,created_at DESC);
  CREATE TABLE IF NOT EXISTS crm_nba_marketing_job_events(
    id bigserial PRIMARY KEY,
    tenant_id bigint NOT NULL,
    job_id uuid NOT NULL REFERENCES crm_nba_marketing_jobs(id) ON DELETE CASCADE,
    event_type text NOT NULL,
    actor text,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS crm_nba_marketing_job_events_job_idx ON crm_nba_marketing_job_events(job_id,id DESC);
`).then(()=>undefined).catch(error=>{schemaPromise=null;throw error});return schemaPromise}

async function setting(tenantId:string){await ensureSchema();await pool.query(`INSERT INTO crm_nba_marketing_settings(tenant_id) VALUES($1::bigint) ON CONFLICT(tenant_id) DO NOTHING`,[tenantId]);return (await pool.query(`SELECT * FROM crm_nba_marketing_settings WHERE tenant_id=$1::bigint`,[tenantId])).rows[0]}
async function logEvent(tenantId:string,jobId:string,type:string,who:string|null,payload:any={}){await pool.query(`INSERT INTO crm_nba_marketing_job_events(tenant_id,job_id,event_type,actor,payload) VALUES($1::bigint,$2::uuid,$3,$4,$5::jsonb)`,[tenantId,jobId,type,who,JSON.stringify(payload)])}
async function clientForTenant(req:TenantAuthRequest,clientId:string):Promise<ClientContact|null>{
  const cap=(await pool.query(`SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='clients' AND column_name='tenant_id') has_tenant_id`)).rows[0]?.has_tenant_id;
  if(!cap&&String(req.tenant!.slug)!=="kleopatra")return null;
  const locationScoped=roles(req.user?.role).some(r=>["location_manager","salon_manager","szalonvezető","szalonvezeto","üzletvezető","uzletvezeto"].includes(r));
  const locationId=locationScoped?String(req.user?.location_id||"").trim():"";
  if(locationScoped&&!locationId)return null;
  const q=await pool.query(`SELECT c.id::text id,COALESCE(NULLIF(to_jsonb(c)->>'full_name',''),NULLIF(to_jsonb(c)->>'name',''),'Vendég') name,NULLIF(to_jsonb(c)->>'email','') email,NULLIF(to_jsonb(c)->>'phone','') phone,COALESCE(NULLIF(to_jsonb(c)->>'marketing_consent','')::boolean,false) marketing_consent,COALESCE(NULLIF(to_jsonb(c)->>'email_consent','')::boolean,false) email_consent,COALESCE(NULLIF(to_jsonb(c)->>'sms_consent','')::boolean,false) sms_consent,COALESCE(NULLIF(to_jsonb(c)->>'phone_consent','')::boolean,false) phone_consent,NULLIF(to_jsonb(c)->>'location_id','') location_id FROM clients c WHERE c.id::text=$1 ${cap?"AND (to_jsonb(c)->>'tenant_id')=$2::text":""} ${locationScoped?`AND (to_jsonb(c)->>'location_id')=$${cap?3:2}::text`:""} LIMIT 1`,cap?(locationScoped?[clientId,String(req.tenant!.id),locationId]:[clientId,String(req.tenant!.id)]):(locationScoped?[clientId,locationId]:[clientId]));
  const r=q.rows[0];if(!r)return null;return{...r,marketing_consent:Boolean(r.marketing_consent),email_consent:Boolean(r.email_consent),sms_consent:Boolean(r.sms_consent),phone_consent:Boolean(r.phone_consent)};
}

const defaults:Record<string,{subject:string;message:string}>={
 FIRST_VISIT:{subject:"Várunk az első Kleopátra élményedre ✨",message:"Kedves {{nev}}! Szeretettel várunk első látogatásodra. Foglalj időpontot az általad választott szolgáltatásra."},
 WIN_BACK_60:{subject:"Hiányzol a Kleopátrából ✨",message:"Kedves {{nev}}! Régen találkoztunk. Várunk vissza egy kis énidőre – válassz új időpontot kényelmesen online."},
 REBOOK_30:{subject:"Ideje a következő időpontnak?",message:"Kedves {{nev}}! Ha szeretnéd folytatni a megszokott szépségápolási rutinodat, most egyszerűen lefoglalhatod a következő időpontodat."},
 VIP_RETENTION:{subject:"Különleges figyelem törzsvendégeinknek",message:"Kedves {{nev}}! Köszönjük, hogy visszatérő vendégünk vagy. Szeretettel várunk a következő alkalommal is."},
 BIRTHDAY_OFFER:{subject:"Boldog születésnapot kíván a Kleopátra! 🎂",message:"Kedves {{nev}}! Születésnapod alkalmából szeretettel várunk egy kis énidőre. Foglalj időpontot kényelmesen online."},
 CROSS_SELL:{subject:"Egy kiegészítő szépségélmény neked",message:"Kedves {{nev}}! Következő látogatásodhoz egy kiegészítő szolgáltatás is jól illeszkedhet. Nézd meg elérhető időpontjainkat."},
 RELATIONSHIP_MAINTENANCE:{subject:"Várunk vissza a Kleopátrába",message:"Kedves {{nev}}! Szeretettel várunk következő látogatásodra. Időpontodat online is lefoglalhatod."}
};
function render(text:string,client:ClientContact){return text.replaceAll("{{nev}}",client.name)}
function consentFor(actionCode:string,channel:Channel,c:ClientContact){const marketing=MARKETING_ACTIONS.has(actionCode);if(channel==="callback")return{allowed:c.phone_consent&&Boolean(c.phone),marketing_required:false,reason:c.phone_consent&&c.phone?null:"Nincs telefonos kapcsolattartási hozzájárulás vagy telefonszám."};if(!marketing)return{allowed:false,marketing_required:false,reason:"Ez az NBA művelet nem marketing automatika; használjon visszahívási feladatot."};if(!c.marketing_consent)return{allowed:false,marketing_required:true,reason:"Nincs aktív marketing-hozzájárulás."};if(channel==="email")return{allowed:Boolean(c.email&&c.email_consent),marketing_required:true,reason:c.email&&c.email_consent?null:"Nincs e-mail cím vagy e-mail hozzájárulás."};if(channel==="sms")return{allowed:Boolean(c.phone&&c.sms_consent),marketing_required:true,reason:c.phone&&c.sms_consent?null:"Nincs telefonszám vagy SMS-hozzájárulás."};return{allowed:false,marketing_required:true,reason:"Push provider még nincs konfigurálva; a feladat sorba állítható, de nem küldhető."}}
function bookingUrl(jobId:string,actionCode:string){const u=new URL(`${SITE_URL}/foglalas`);u.searchParams.set("utm_source","vir_nba");u.searchParams.set("utm_medium","crm_automation");u.searchParams.set("utm_campaign",actionCode.toLowerCase());u.searchParams.set("nba_job_id",jobId);return u.toString()}

async function dispatch(job:any,who:string|null){
  if(!["approved","queued"].includes(String(job.status)))throw Object.assign(new Error("Csak jóváhagyott vagy sorban álló feladat küldhető."),{status:409,code:"NBA_MARKETING_JOB_NOT_SENDABLE"});
  const c=(await pool.query(`SELECT COALESCE(NULLIF(to_jsonb(c)->>'full_name',''),NULLIF(to_jsonb(c)->>'name',''),'Vendég') name,NULLIF(to_jsonb(c)->>'email','') email,NULLIF(to_jsonb(c)->>'phone','') phone,COALESCE(NULLIF(to_jsonb(c)->>'marketing_consent','')::boolean,false) marketing_consent,COALESCE(NULLIF(to_jsonb(c)->>'email_consent','')::boolean,false) email_consent,COALESCE(NULLIF(to_jsonb(c)->>'sms_consent','')::boolean,false) sms_consent,COALESCE(NULLIF(to_jsonb(c)->>'phone_consent','')::boolean,false) phone_consent FROM clients c WHERE c.id::text=$1 LIMIT 1`,[job.client_id])).rows[0];
  if(!c)throw Object.assign(new Error("A vendég már nem található."),{status:404,code:"CLIENT_NOT_FOUND"});
  const check=consentFor(job.action_code,job.channel,{id:job.client_id,location_id:null,...c});
  if(job.channel==="callback"){await pool.query(`UPDATE crm_nba_marketing_jobs SET status='ready',updated_at=now() WHERE id=$1::uuid`,[job.id]);await logEvent(String(job.tenant_id),job.id,"callback_ready",who,{channel:"callback"});return{status:"ready"}}
  if(job.channel==="push"){await pool.query(`UPDATE crm_nba_marketing_jobs SET status='waiting_provider',error='PUSH_PROVIDER_NOT_CONFIGURED',updated_at=now() WHERE id=$1::uuid`,[job.id]);await logEvent(String(job.tenant_id),job.id,"push_waiting_provider",who,{});return{status:"waiting_provider"}}
  if(!check.allowed){await pool.query(`UPDATE crm_nba_marketing_jobs SET status='blocked',error=$2,updated_at=now() WHERE id=$1::uuid`,[job.id,check.reason]);await logEvent(String(job.tenant_id),job.id,"dispatch_blocked",who,{reason:check.reason});return{status:"blocked",reason:check.reason}}
  const link=bookingUrl(job.id,job.action_code);try{
    if(job.channel==="email"){const html=`<div style="font-family:Arial,sans-serif;line-height:1.6"><p>${String(job.message).replace(/\n/g,"<br>")}</p><p><a href="${link}">Időpontot foglalok</a></p><p style="font-size:11px;color:#777">Kleopátra Szépségszalonok · NBA marketing automatika · hozzájárulás alapján.</p></div>`;await sendEmail({to:c.email,subject:job.subject||"Kleopátra",text:`${job.message}\n\nFoglalás: ${link}`,html})}
    if(job.channel==="sms")await sendSms({to:c.phone,text:`Kleopátra: ${job.message} Foglalás: ${link}`});
    await pool.query(`UPDATE crm_nba_marketing_jobs SET status='sent',sent_at=now(),error=NULL,updated_at=now() WHERE id=$1::uuid`,[job.id]);await logEvent(String(job.tenant_id),job.id,"sent",who,{channel:job.channel,attribution_key:job.attribution_key});return{status:"sent"};
  }catch(error:any){await pool.query(`UPDATE crm_nba_marketing_jobs SET status='failed',error=$2,updated_at=now() WHERE id=$1::uuid`,[job.id,String(error?.message||error).slice(0,500)]);await logEvent(String(job.tenant_id),job.id,"send_failed",who,{error:String(error?.message||error).slice(0,500)});throw error}
}

router.use(requireAuth,requireTenantContext,requireManagement);
router.use(async(_req,_res,next)=>{try{await ensureSchema();next()}catch(error){next(error)}});

router.get("/settings",async(req:TenantAuthRequest,res:Response)=>res.json({ok:true,settings:await setting(String(req.tenant!.id)),push_provider_ready:false}));
router.patch("/settings",async(req:TenantAuthRequest,res:Response)=>{const current=await setting(String(req.tenant!.id));const channel=CHANNELS.has(String(req.body?.default_channel))?String(req.body.default_channel):current.default_channel;const q=await pool.query(`UPDATE crm_nba_marketing_settings SET auto_dispatch=$2,require_explicit_approval=$3,default_channel=$4,max_daily_dispatch=$5,updated_by=$6,updated_at=now() WHERE tenant_id=$1::bigint RETURNING *`,[req.tenant!.id,req.body?.auto_dispatch===undefined?current.auto_dispatch:Boolean(req.body.auto_dispatch),req.body?.require_explicit_approval===undefined?current.require_explicit_approval:Boolean(req.body.require_explicit_approval),channel,Math.max(1,Math.min(5000,Number(req.body?.max_daily_dispatch||current.max_daily_dispatch))),actor(req)]);return res.json({ok:true,settings:q.rows[0]})});

router.get("/jobs",async(req:TenantAuthRequest,res:Response)=>{const status=String(req.query.status||"").trim();const clientId=String(req.query.client_id||"").trim();const q=await pool.query(`SELECT j.*,e.action_status nba_action_status,e.payload nba_payload FROM crm_nba_marketing_jobs j LEFT JOIN crm_next_best_action_events e ON e.id=j.nba_event_id WHERE j.tenant_id=$1::bigint AND ($2::text='' OR j.status=$2) AND ($3::text='' OR j.client_id=$3) ORDER BY j.created_at DESC LIMIT 300`,[req.tenant!.id,status,clientId]);return res.json({ok:true,rows:q.rows})});

router.post("/jobs",async(req:TenantAuthRequest,res:Response)=>{
  const eventId=String(req.body?.nba_event_id||"").trim(),channel=String(req.body?.channel||"").trim().toLowerCase() as Channel;if(!eventId||!CHANNELS.has(channel))return res.status(400).json({ok:false,code:"NBA_MARKETING_JOB_INVALID",error:"Hiányzó NBA esemény vagy érvénytelen csatorna."});
  const ev=(await pool.query(`SELECT * FROM crm_next_best_action_events WHERE id=$1::uuid AND tenant_id=$2::bigint LIMIT 1`,[eventId,req.tenant!.id])).rows[0];if(!ev)return res.status(404).json({ok:false,code:"NBA_EVENT_NOT_FOUND",error:"Az NBA esemény nem található ebben a tenantban."});if(ev.action_status!=="accepted")return res.status(409).json({ok:false,code:"NBA_ACTION_NOT_ACCEPTED",error:"Marketing feladat csak elfogadott Next Best Actionből készíthető."});
  const c=await clientForTenant(req,String(ev.client_id));if(!c)return res.status(404).json({ok:false,code:"CLIENT_NOT_FOUND",error:"A vendég nem található a jelenlegi tenant/telephely scope-ban."});const check=consentFor(String(ev.action_code),channel,c);const tpl=defaults[String(ev.action_code)]||defaults.RELATIONSHIP_MAINTENANCE;const subject=clean(req.body?.subject||tpl.subject,500),message=render(clean(req.body?.message||tpl.message,3000),c);const scheduled=String(req.body?.scheduled_at||"").trim()||null;const attribution=`nba:${req.tenant!.id}:${eventId}:${channel}`;const status=check.allowed||channel==="push"?"draft":"blocked";
  const q=await pool.query(`INSERT INTO crm_nba_marketing_jobs(tenant_id,client_id,nba_event_id,action_code,recommendation_version,channel,status,subject,message,scheduled_at,consent_snapshot,recommendation_snapshot,attribution_key,error,created_by) VALUES($1::bigint,$2,$3::uuid,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11::jsonb,$12::jsonb,$13,$14,$15) ON CONFLICT(tenant_id,nba_event_id,channel) DO UPDATE SET subject=EXCLUDED.subject,message=EXCLUDED.message,scheduled_at=EXCLUDED.scheduled_at,consent_snapshot=EXCLUDED.consent_snapshot,recommendation_snapshot=EXCLUDED.recommendation_snapshot,error=EXCLUDED.error,updated_at=now() RETURNING *`,[req.tenant!.id,ev.client_id,eventId,ev.action_code,ev.recommendation_version||"nba-v1",channel,status,subject,message,scheduled,JSON.stringify({...check,marketing_consent:c.marketing_consent,email_consent:c.email_consent,sms_consent:c.sms_consent,phone_consent:c.phone_consent,has_email:Boolean(c.email),has_phone:Boolean(c.phone),captured_at:new Date().toISOString()}),JSON.stringify(ev.payload||{}),attribution,check.allowed?null:check.reason,actor(req)]);await logEvent(String(req.tenant!.id),q.rows[0].id,"job_created",actor(req),{nba_event_id:eventId,action_code:ev.action_code,channel,status,consent:check});return res.status(201).json({ok:true,job:q.rows[0],consent:check})
});

router.post("/jobs/:id/approve",async(req:TenantAuthRequest,res:Response)=>{const job=(await pool.query(`SELECT * FROM crm_nba_marketing_jobs WHERE id=$1::uuid AND tenant_id=$2::bigint LIMIT 1`,[req.params.id,req.tenant!.id])).rows[0];if(!job)return res.status(404).json({ok:false,error:"Marketing feladat nem található."});if(job.status==="blocked")return res.status(409).json({ok:false,code:"NBA_MARKETING_CONSENT_BLOCKED",error:job.error||"A hozzájárulás miatt a feladat blokkolt."});if(["sent","completed","cancelled"].includes(job.status))return res.status(409).json({ok:false,code:"NBA_MARKETING_JOB_FINAL",error:"A feladat már lezárt állapotú."});const next=job.channel==="callback"?"ready":job.channel==="push"?"waiting_provider":"queued";const q=await pool.query(`UPDATE crm_nba_marketing_jobs SET status=$3,approved_by=$4,approved_at=now(),updated_at=now() WHERE id=$1::uuid AND tenant_id=$2::bigint RETURNING *`,[job.id,req.tenant!.id,next,actor(req)]);await logEvent(String(req.tenant!.id),job.id,"approved",actor(req),{next_status:next});const cfg=await setting(String(req.tenant!.id));if(cfg.auto_dispatch&&!cfg.require_explicit_approval&&["email","sms"].includes(job.channel)&&(!job.scheduled_at||new Date(job.scheduled_at)<=new Date())){const result=await dispatch(q.rows[0],actor(req));return res.json({ok:true,job:(await pool.query(`SELECT * FROM crm_nba_marketing_jobs WHERE id=$1`,[job.id])).rows[0],dispatch:result})}return res.json({ok:true,job:q.rows[0]})});

router.post("/jobs/:id/send",async(req:TenantAuthRequest,res:Response)=>{const job=(await pool.query(`SELECT * FROM crm_nba_marketing_jobs WHERE id=$1::uuid AND tenant_id=$2::bigint LIMIT 1`,[req.params.id,req.tenant!.id])).rows[0];if(!job)return res.status(404).json({ok:false,error:"Marketing feladat nem található."});if(job.scheduled_at&&new Date(job.scheduled_at)>new Date())return res.status(409).json({ok:false,code:"NBA_MARKETING_NOT_DUE",error:"A feladat ütemezett időpontja még nem érkezett el."});const result=await dispatch(job,actor(req));return res.json({ok:true,result,job:(await pool.query(`SELECT * FROM crm_nba_marketing_jobs WHERE id=$1`,[job.id])).rows[0]})});

router.post("/jobs/:id/complete",async(req:TenantAuthRequest,res:Response)=>{const q=await pool.query(`UPDATE crm_nba_marketing_jobs SET status='completed',completed_at=now(),updated_at=now(),error=NULL WHERE id=$1::uuid AND tenant_id=$2::bigint AND status IN('ready','sent','waiting_provider') RETURNING *`,[req.params.id,req.tenant!.id]);if(!q.rows[0])return res.status(409).json({ok:false,error:"A feladat nem lezárható vagy nem található."});await logEvent(String(req.tenant!.id),q.rows[0].id,"completed",actor(req),{note:clean(req.body?.note,500)||null});return res.json({ok:true,job:q.rows[0]})});
router.post("/jobs/:id/cancel",async(req:TenantAuthRequest,res:Response)=>{const q=await pool.query(`UPDATE crm_nba_marketing_jobs SET status='cancelled',updated_at=now() WHERE id=$1::uuid AND tenant_id=$2::bigint AND status NOT IN('sent','completed','cancelled') RETURNING *`,[req.params.id,req.tenant!.id]);if(!q.rows[0])return res.status(409).json({ok:false,error:"A feladat nem törölhető vagy nem található."});await logEvent(String(req.tenant!.id),q.rows[0].id,"cancelled",actor(req),{});return res.json({ok:true,job:q.rows[0]})});
router.get("/jobs/:id/events",async(req:TenantAuthRequest,res:Response)=>{const exists=(await pool.query(`SELECT 1 FROM crm_nba_marketing_jobs WHERE id=$1::uuid AND tenant_id=$2::bigint`,[req.params.id,req.tenant!.id])).rowCount;if(!exists)return res.status(404).json({ok:false,error:"Marketing feladat nem található."});const rows=(await pool.query(`SELECT event_type,actor,payload,created_at FROM crm_nba_marketing_job_events WHERE job_id=$1::uuid AND tenant_id=$2::bigint ORDER BY id DESC LIMIT 100`,[req.params.id,req.tenant!.id])).rows;return res.json({ok:true,rows})});

async function processDue(){if(schedulerBusy)return;schedulerBusy=true;try{await ensureSchema();const tenants=(await pool.query(`SELECT tenant_id,max_daily_dispatch FROM crm_nba_marketing_settings WHERE auto_dispatch=true AND require_explicit_approval=false`)).rows;for(const t of tenants){const remaining=Math.max(0,Number(t.max_daily_dispatch||100)-Number((await pool.query(`SELECT count(*)::int n FROM crm_nba_marketing_jobs WHERE tenant_id=$1::bigint AND sent_at>=CURRENT_DATE`,[t.tenant_id])).rows[0]?.n||0));if(!remaining)continue;const jobs=(await pool.query(`SELECT * FROM crm_nba_marketing_jobs WHERE tenant_id=$1::bigint AND status='queued' AND channel IN('email','sms') AND (scheduled_at IS NULL OR scheduled_at<=now()) ORDER BY created_at LIMIT $2`,[t.tenant_id,remaining])).rows;for(const j of jobs)try{await dispatch(j,"scheduler")}catch(error:any){console.warn("[nba-marketing] dispatch",j.id,error?.message||error)}}}catch(error:any){console.warn("[nba-marketing] scheduler",error?.message||error)}finally{schedulerBusy=false}}
const timer=setInterval(()=>void processDue(),5*60*1000);timer.unref();setTimeout(()=>void processDue(),120000).unref();

export default router;
