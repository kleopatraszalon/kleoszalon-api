import crypto from "crypto";
import { Request,Response,Router } from "express";
import db from "../db";
import { issueTenantAdminInvitation } from "../services/tenantAdminInvitations";
import { activateSelfServiceTrial,ensureSelfServiceSignupSchema } from "../services/saasSelfService";
import { ensureRevenueSchema } from "./saasRevenue";

const router=Router();
const EMAIL_RE=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SELF_SERVICE_PLANS=new Set(['start','pro']);
const TERMS_VERSION=String(process.env.SAAS_TERMS_VERSION||'2026-08-19');
const PRIVACY_VERSION=String(process.env.SAAS_PRIVACY_VERSION||'2026-08-19');
const RATE_PEPPER=String(process.env.SAAS_SIGNUP_RATE_PEPPER||'kleosaas-public-signup-v1');

const clean=(value:unknown,max=180)=>String(value||'').trim().slice(0,max);
const email=(value:unknown)=>clean(value,254).toLowerCase();
function hashIp(req:Request){const raw=String(req.ip||req.socket?.remoteAddress||'unknown');return crypto.createHash('sha256').update(`${RATE_PEPPER}:${raw}`).digest('hex');}
function slugBase(value:string){const normalized=value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,50);return normalized.length>=3?normalized:'szalon';}
async function uniqueSlug(name:string,client:any){const base=slugBase(name);for(let i=0;i<20;i++){const suffix=i===0?'':`-${String(Math.floor(1000+Math.random()*9000))}`;const candidate=`${base.slice(0,63-suffix.length)}${suffix}`;const exists=await client.query(`SELECT 1 FROM tenants WHERE slug=$1 LIMIT 1`,[candidate]);if(!exists.rowCount)return candidate;}return `${base.slice(0,54)}-${crypto.randomBytes(4).toString('hex')}`;}
async function publicPlans(){await ensureRevenueSchema();const{rows}=await db.query(`SELECT code,name,monthly_price,annual_price,currency,max_locations,max_users,features,trial_days,recommended,booking_commission_percent FROM subscription_plans WHERE active=true AND public_visible=true AND code=ANY($1::text[]) ORDER BY monthly_price`,[[...SELF_SERVICE_PLANS]]);return rows;}
async function signupSnapshot(requestKey:string){const{rows}=await db.query(`SELECT ss.id::text signup_id,ss.status,ss.plan_code,ss.billing_interval,ss.owner_email,ss.activation_expires_at,ss.activated_at,t.slug tenant_slug,t.name tenant_name,s.trial_ends_at FROM saas_self_service_signups ss JOIN tenants t ON t.id=ss.tenant_id LEFT JOIN LATERAL(SELECT trial_ends_at FROM subscriptions WHERE tenant_id=t.id ORDER BY created_at DESC LIMIT 1)s ON true WHERE ss.request_key=$1 LIMIT 1`,[requestKey]);return rows[0]||null;}

router.use(async(_req,_res,next)=>{try{await ensureRevenueSchema();await ensureSelfServiceSignupSchema();next();}catch(error){next(error);}});
router.get('/plans',async(_req,res)=>{try{return res.json({ok:true,trial_requires_email_activation:true,plans:await publicPlans()});}catch(error){console.error('[SAAS SELF SERVICE] plans',error);return res.status(500).json({ok:false,error:'A próbaidős csomagok nem tölthetők be.'});}});

router.post('/signup',async(req:Request,res:Response)=>{
 const requestKey=clean(req.header('Idempotency-Key'),128);if(requestKey.length<16)return res.status(400).json({ok:false,code:'IDEMPOTENCY_KEY_REQUIRED',error:'A biztonságos regisztrációhoz Idempotency-Key szükséges.'});
 const existing=await signupSnapshot(requestKey).catch(()=>null);if(existing&&existing.status!=='invite_failed')return res.status(200).json({ok:true,idempotent:true,activation_required:existing.status!=='active',signup:existing});
 const planCode=clean(req.body?.plan_code,30).toLowerCase(),billingInterval=req.body?.billing_interval==='year'?'year':'month';
 const companyName=clean(req.body?.company_name,160),legalName=clean(req.body?.legal_name||req.body?.company_name,180),taxNumber=clean(req.body?.tax_number,40)||null;
 const ownerEmail=email(req.body?.owner_email),locationName=clean(req.body?.location_name||companyName,160),city=clean(req.body?.city,120),address=clean(req.body?.address,240)||null;
 const marketingConsent=req.body?.marketing_consent===true,termsAccepted=req.body?.terms_accepted===true,privacyAccepted=req.body?.privacy_accepted===true,honeypot=clean(req.body?.website,120);
 if(honeypot)return res.status(202).json({ok:true,activation_required:true});
 if(!SELF_SERVICE_PLANS.has(planCode))return res.status(400).json({ok:false,code:'SELF_SERVICE_PLAN_FORBIDDEN',error:'Self-service próbaidő csak START vagy PRO csomaggal indítható.'});
 if(companyName.length<2||legalName.length<2)return res.status(400).json({ok:false,error:'A cégnév kötelező.'});
 if(!EMAIL_RE.test(ownerEmail))return res.status(400).json({ok:false,error:'Érvényes tulajdonosi e-mail cím szükséges.'});
 if(locationName.length<2||city.length<2)return res.status(400).json({ok:false,error:'Az első telephely neve és városa kötelező.'});
 if(!termsAccepted||!privacyAccepted)return res.status(400).json({ok:false,code:'LEGAL_CONSENT_REQUIRED',error:'Az ÁSZF és az adatkezelési tájékoztató elfogadása kötelező.'});
 const ipHash=hashIp(req);
 try{
  const abuse=await db.query(`SELECT COUNT(*) FILTER(WHERE ip_hash=$1 AND created_at>now()-interval '1 hour')::int ip_hour,COUNT(*) FILTER(WHERE lower(owner_email)=lower($2) AND created_at>now()-interval '24 hours')::int email_day FROM saas_self_service_signups WHERE created_at>now()-interval '24 hours'`,[ipHash,ownerEmail]);
  if(Number(abuse.rows[0]?.ip_hour||0)>=5||Number(abuse.rows[0]?.email_day||0)>=3)return res.status(429).json({ok:false,code:'SIGNUP_RATE_LIMITED',error:'Túl sok próbaregisztráció történt. Próbálja meg később.'});
  const pending=await db.query(`SELECT request_key FROM saas_self_service_signups WHERE lower(owner_email)=lower($1) AND status IN('pending_activation','invited') AND activation_expires_at>now() ORDER BY created_at DESC LIMIT 1`,[ownerEmail]);
  if(pending.rowCount&&pending.rows[0].request_key!==requestKey)return res.status(409).json({ok:false,code:'SIGNUP_ALREADY_PENDING',error:'Ehhez az e-mail címhez már tartozik aktiválásra váró SaaS regisztráció.'});
  const plan=(await db.query(`SELECT id,code,name,features,trial_days FROM subscription_plans WHERE code=$1 AND active=true AND public_visible=true LIMIT 1`,[planCode])).rows[0];
  if(!plan||Number(plan.trial_days||0)<=0)return res.status(409).json({ok:false,error:'Ehhez a csomaghoz jelenleg nem indítható próbaidő.'});
  let tenantId='',tenantSlug='';
  if(existing?.status==='invite_failed'){
    const retry=await db.query(`SELECT tenant_id::text FROM saas_self_service_signups WHERE request_key=$1 AND status='invite_failed' LIMIT 1`,[requestKey]);tenantId=String(retry.rows[0]?.tenant_id||'');
    const t=tenantId?await db.query(`SELECT slug FROM tenants WHERE id=$1::bigint`,[tenantId]):null;tenantSlug=String(t?.rows[0]?.slug||'');
  }else{
    const client=await db.connect();try{
      await client.query('BEGIN');tenantSlug=await uniqueSlug(companyName,client);
      const tenant=await client.query(`INSERT INTO tenants(slug,name,legal_name,tax_number,billing_email,status) VALUES($1,$2,$3,$4,$5,'pending_activation') RETURNING id::text`,[tenantSlug,companyName,legalName,taxNumber,ownerEmail]);tenantId=String(tenant.rows[0].id);
      await client.query(`INSERT INTO tenant_settings(tenant_id,settings) VALUES($1::bigint,$2::jsonb)`,[tenantId,JSON.stringify({signup_source:'self_service',billing_interval:billingInterval,marketing_consent:marketingConsent})]);
      await client.query(`INSERT INTO tenant_branding(tenant_id,app_name,primary_color,email_sender_name) VALUES($1::bigint,$2,'#7C5CE5',$2) ON CONFLICT(tenant_id) DO NOTHING`,[tenantId,companyName]);
      const location=await client.query(`INSERT INTO locations(name,city,address,email,is_active,tenant_id) VALUES($1,$2,$3,$4,true,$5::bigint) RETURNING id::text`,[locationName,city,address,ownerEmail,tenantId]);
      await client.query(`INSERT INTO subscriptions(tenant_id,plan_id,status,starts_at,trial_ends_at,billing_interval) VALUES($1::bigint,$2,'trial',now(),NULL,$3)`,[tenantId,plan.id,billingInterval]);
      const features=plan.features?.all_modules===true?['booking','crm','hr','inventory','finance','marketing','franchise','mobile_app','white_label','api','payroll','ai']:Object.entries(plan.features||{}).filter(([,v])=>v===true).map(([k])=>k);
      for(const featureKey of features)await client.query(`INSERT INTO tenant_features(tenant_id,feature_key,enabled,config) VALUES($1::bigint,$2,true,'{}'::jsonb) ON CONFLICT(tenant_id,feature_key) DO UPDATE SET enabled=true,updated_at=now()`,[tenantId,featureKey]);
      await client.query(`INSERT INTO tenant_onboarding(tenant_id,status,current_step,created_by) VALUES($1::bigint,'in_progress','admin','self_service') ON CONFLICT(tenant_id) DO NOTHING`,[tenantId]);
      await client.query(`INSERT INTO tenant_onboarding_events(tenant_id,step_key,event_type,actor_user_id,payload) VALUES($1::bigint,'company','self_service_provisioned','self_service',$2::jsonb)`,[tenantId,JSON.stringify({plan_code:planCode,billing_interval:billingInterval,location_id:String(location.rows[0].id),features})]);
      await client.query(`INSERT INTO subscription_events(tenant_id,subscription_id,event_type,source,payload) SELECT $1::bigint,id,'self_service_signup_created','self_service',$2::jsonb FROM subscriptions WHERE tenant_id=$1::bigint ORDER BY created_at DESC LIMIT 1`,[tenantId,JSON.stringify({plan_code:planCode,billing_interval:billingInterval,trial_starts_after_email_activation:true})]);
      await client.query(`INSERT INTO saas_self_service_signups(request_key,tenant_id,plan_code,billing_interval,owner_email,ip_hash,status,terms_version,privacy_version,marketing_consent) VALUES($1,$2::bigint,$3,$4,$5,$6,'pending_activation',$7,$8,$9)`,[requestKey,tenantId,planCode,billingInterval,ownerEmail,ipHash,TERMS_VERSION,PRIVACY_VERSION,marketingConsent]);
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
  }
  try{
    const invite=await issueTenantAdminInvitation({tenantId,email:ownerEmail,invitedBy:'self_service',tenantName:companyName});
    if(invite.assigned){const client=await db.connect();try{await client.query('BEGIN');await activateSelfServiceTrial(client,tenantId,String(invite.user_id||''));await client.query('COMMIT');}catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}}
    else await db.query(`UPDATE saas_self_service_signups SET status='invited',invited_at=now(),last_error=NULL,updated_at=now() WHERE tenant_id=$1::bigint`,[tenantId]);
    const snapshot=await signupSnapshot(requestKey);return res.status(existing?200:201).json({ok:true,activation_required:!invite.assigned,email_sent:!invite.assigned&&Boolean(invite.delivery?.sent||invite.delivery?.logged),signup:snapshot});
  }catch(error:any){await db.query(`UPDATE saas_self_service_signups SET status='invite_failed',last_error=$2,updated_at=now() WHERE tenant_id=$1::bigint`,[tenantId,String(error?.code||error?.message||'INVITE_FAILED').slice(0,500)]).catch(()=>undefined);return res.status(502).json({ok:false,code:'ACTIVATION_EMAIL_FAILED',retryable:true,error:'A tenant előkészült, de az aktiváló e-mail küldése nem sikerült. Ugyanezzel a regisztrációval újrapróbálható.'});}
 }catch(error:any){if(error?.code==='23505')return res.status(409).json({ok:false,code:'SIGNUP_CONFLICT',error:'A regisztráció már létezik vagy az azonosító foglalt.'});console.error('[SAAS SELF SERVICE] signup',error);return res.status(500).json({ok:false,error:'A SaaS próbaregisztráció nem hozható létre.'});}
});

export default router;
