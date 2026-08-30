import {Router,Request,Response} from "express";
import crypto from "node:crypto";
import pool from "../db";

const router=Router();
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOUCH=/KLEO_TOUCH:([0-9a-f-]{36})/i;

type ProviderScope={tenantId:string;locationId:string|null};

async function ensureSchema(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vir_communication_provider_accounts(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,location_id uuid,
      provider text NOT NULL,external_account_id text NOT NULL,active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(provider,external_account_id)
    );
    CREATE TABLE IF NOT EXISTS vir_client_channel_identities(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,client_id uuid,
      channel text NOT NULL,external_id text NOT NULL,display_name text,verified boolean NOT NULL DEFAULT false,
      transactional_consent boolean NOT NULL DEFAULT false,marketing_consent boolean NOT NULL DEFAULT false,
      last_activity_at timestamptz,metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(tenant_id,channel,external_id)
    );
    ALTER TABLE vir_client_channel_identities ALTER COLUMN client_id DROP NOT NULL;
    CREATE TABLE IF NOT EXISTS vir_conversations(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,location_id uuid,client_id uuid,
      channel text NOT NULL,external_thread_id text,status text NOT NULL DEFAULT 'open',assigned_user_id uuid,
      last_message_at timestamptz,ai_handoff_required boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS vir_conversation_messages(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,conversation_id uuid NOT NULL,
      direction text NOT NULL,provider_message_id text,body text NOT NULL DEFAULT '',sent_at timestamptz NOT NULL DEFAULT now(),
      delivery_status text NOT NULL DEFAULT 'received',attribution_touch_id uuid,metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE TABLE IF NOT EXISTS vir_communication_touches(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,location_id uuid,client_id uuid,
      channel text NOT NULL,campaign_key text,purpose text NOT NULL DEFAULT 'transactional',status text NOT NULL DEFAULT 'queued',
      cost_amount numeric(12,4) NOT NULL DEFAULT 0,currency text NOT NULL DEFAULT 'HUF',sent_at timestamptz,
      delivered_at timestamptz,clicked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE vir_communication_touches ADD COLUMN IF NOT EXISTS provider_message_id text;
    ALTER TABLE vir_communication_touches ADD COLUMN IF NOT EXISTS recipient_external_id text;
    ALTER TABLE vir_communication_touches ADD COLUMN IF NOT EXISTS read_at timestamptz;
    ALTER TABLE vir_communication_touches ADD COLUMN IF NOT EXISTS failed_at timestamptz;
    ALTER TABLE vir_communication_touches ADD COLUMN IF NOT EXISTS responded_at timestamptz;
    CREATE INDEX IF NOT EXISTS vir_communication_touch_provider_idx ON vir_communication_touches(channel,provider_message_id);
    CREATE INDEX IF NOT EXISTS vir_communication_touch_recipient_idx ON vir_communication_touches(tenant_id,channel,recipient_external_id,sent_at DESC);
  `);
}

function rawBody(req:Request){const raw=(req as any).rawBody;return Buffer.isBuffer(raw)?raw:Buffer.from(JSON.stringify(req.body||{}));}
function safeEqualHex(actual:string,expected:string){try{const a=Buffer.from(actual,"hex"),b=Buffer.from(expected,"hex");return a.length===b.length&&a.length>0&&crypto.timingSafeEqual(a,b)}catch{return false}}
function parseClientHint(...values:unknown[]){for(const value of values){const text=String(value||"");const direct=text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i)?.[0];if(direct&&UUID.test(direct))return direct}return null}
function parseTouchHint(...values:unknown[]){for(const value of values){const match=String(value||"").match(TOUCH)?.[1];if(match&&UUID.test(match))return match}return null}

async function resolveScope(provider:"viber"|"messenger",externalAccountId:string):Promise<ProviderScope|null>{
  await ensureSchema();
  const mapped=(await pool.query(`SELECT tenant_id::text,location_id::text FROM vir_communication_provider_accounts WHERE provider=$1 AND external_account_id=$2 AND active=true LIMIT 1`,[provider,externalAccountId])).rows[0];
  if(mapped)return{tenantId:String(mapped.tenant_id),locationId:mapped.location_id?String(mapped.location_id):null};
  const prefix=provider==="viber"?"VIBER":"MESSENGER";
  const tenantId=String(process.env[`${prefix}_TENANT_ID`]||process.env.COMMUNICATION_DEFAULT_TENANT_ID||"").trim();
  const locationId=String(process.env[`${prefix}_LOCATION_ID`]||"").trim();
  if(!UUID.test(tenantId))return null;
  return{tenantId,locationId:UUID.test(locationId)?locationId:null};
}

async function verifiedClient(tenantId:string,clientHint:string|null){if(!clientHint)return null;const ok=(await pool.query(`SELECT 1 FROM clients c WHERE c.id=$2::uuid AND EXISTS(SELECT 1 FROM appointments a WHERE a.tenant_id=$1::uuid AND a.client_id=c.id LIMIT 1)`,[tenantId,clientHint])).rowCount;return ok?clientHint:null}

async function upsertIdentity(scope:ProviderScope,channel:"viber"|"messenger",externalId:string,displayName:string|null,clientHint:string|null,transactionalConsent:boolean,metadata:any){
  const clientId=await verifiedClient(scope.tenantId,clientHint);
  return (await pool.query(`INSERT INTO vir_client_channel_identities(tenant_id,client_id,channel,external_id,display_name,verified,transactional_consent,marketing_consent,last_activity_at,metadata)
    VALUES($1::uuid,$2::uuid,$3,$4,$5,true,$6,false,now(),$7::jsonb)
    ON CONFLICT(tenant_id,channel,external_id) DO UPDATE SET
      client_id=COALESCE(EXCLUDED.client_id,vir_client_channel_identities.client_id),display_name=COALESCE(EXCLUDED.display_name,vir_client_channel_identities.display_name),
      verified=true,transactional_consent=(vir_client_channel_identities.transactional_consent OR EXCLUDED.transactional_consent),
      last_activity_at=now(),metadata=vir_client_channel_identities.metadata||EXCLUDED.metadata,updated_at=now()
    RETURNING *`,[scope.tenantId,clientId,channel,externalId,displayName,transactionalConsent,JSON.stringify(metadata||{})])).rows[0];
}

async function ingestInbound(scope:ProviderScope,channel:"viber"|"messenger",externalId:string,body:string,providerMessageId:string|null,metadata:any,clientId:string|null){
  let conv=(await pool.query(`SELECT * FROM vir_conversations WHERE tenant_id=$1::uuid AND channel=$2 AND external_thread_id=$3 AND status='open' ORDER BY created_at DESC LIMIT 1`,[scope.tenantId,channel,externalId])).rows[0];
  if(!conv)conv=(await pool.query(`INSERT INTO vir_conversations(tenant_id,location_id,client_id,channel,external_thread_id,last_message_at) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,now()) RETURNING *`,[scope.tenantId,scope.locationId,clientId,channel,externalId])).rows[0];
  await pool.query(`INSERT INTO vir_conversation_messages(tenant_id,conversation_id,direction,provider_message_id,body,delivery_status,metadata) VALUES($1::uuid,$2::uuid,'inbound',$3,$4,'received',$5::jsonb)`,[scope.tenantId,conv.id,providerMessageId,body,JSON.stringify(metadata||{})]);
  await pool.query(`UPDATE vir_conversations SET client_id=COALESCE(client_id,$3::uuid),last_message_at=now(),updated_at=now() WHERE id=$1::uuid AND tenant_id=$2::uuid`,[conv.id,scope.tenantId,clientId]);
}

async function updateTouchByProviderMessage(channel:string,providerMessageId:string,event:"delivered"|"seen"|"failed"){
  if(!providerMessageId)return;
  const set=event==="delivered"?"status='delivered',delivered_at=COALESCE(delivered_at,now())":event==="seen"?"status='read',delivered_at=COALESCE(delivered_at,now()),read_at=COALESCE(read_at,now())":"status='failed',failed_at=COALESCE(failed_at,now())";
  await pool.query(`UPDATE vir_communication_touches SET ${set} WHERE channel=$1 AND provider_message_id=$2`,[channel,providerMessageId]);
}

router.post('/viber',async(req:Request,res:Response)=>{
  try{
    const token=String(process.env.VIBER_BOT_TOKEN||"").trim();if(!token)return res.status(503).json({ok:false,error:'viber_not_configured'});
    const signature=String(req.header('X-Viber-Content-Signature')||'').trim().toLowerCase();
    const expected=crypto.createHmac('sha256',token).update(rawBody(req)).digest('hex');
    if(!safeEqualHex(signature,expected))return res.status(401).json({ok:false,error:'invalid_viber_signature'});
    await ensureSchema();
    const event=String(req.body?.event||'');
    if(event==='webhook')return res.status(200).json({ok:true});
    const scope=await resolveScope('viber',String(process.env.VIBER_BOT_ID||'default'));if(!scope)return res.status(503).json({ok:false,error:'viber_tenant_mapping_missing'});
    const externalId=String(req.body?.user?.id||req.body?.sender?.id||req.body?.user_id||'').trim();
    const clientHint=parseClientHint(req.body?.context,req.body?.message?.tracking_data);
    if(externalId){
      const ident=await upsertIdentity(scope,'viber',externalId,String(req.body?.user?.name||req.body?.sender?.name||'')||null,clientHint,event==='subscribed'||event==='message',{event,country:req.body?.user?.country||req.body?.sender?.country||null,language:req.body?.user?.language||req.body?.sender?.language||null});
      if(event==='unsubscribed')await pool.query(`UPDATE vir_client_channel_identities SET transactional_consent=false,last_activity_at=now(),metadata=metadata||'{"unsubscribed":true}'::jsonb,updated_at=now() WHERE id=$1`,[ident.id]);
      if(event==='message'){
        const text=String(req.body?.message?.text||'').trim();if(text)await ingestInbound(scope,'viber',externalId,text,String(req.body?.message_token||req.body?.message?.token||'')||null,req.body,ident.client_id||null);
        const touchId=parseTouchHint(req.body?.message?.tracking_data);if(touchId)await pool.query(`UPDATE vir_communication_touches SET responded_at=COALESCE(responded_at,now()) WHERE id=$1::uuid AND tenant_id=$2::uuid`,[touchId,scope.tenantId]);
      }
    }
    if(['delivered','seen','failed'].includes(event))await updateTouchByProviderMessage('viber',String(req.body?.message_token||''),event as any);
    return res.status(200).json({ok:true});
  }catch(e:any){console.error('Viber webhook error',e?.message||e);return res.status(500).json({ok:false,error:'viber_webhook_failed'});}
});

router.get('/meta',async(req:Request,res:Response)=>{
  const verify=String(process.env.MESSENGER_VERIFY_TOKEN||'').trim();
  if(String(req.query['hub.mode']||'')==='subscribe'&&verify&&String(req.query['hub.verify_token']||'')===verify)return res.status(200).send(String(req.query['hub.challenge']||''));
  return res.status(403).send('verification_failed');
});

router.post('/meta',async(req:Request,res:Response)=>{
  try{
    const secret=String(process.env.MESSENGER_APP_SECRET||'').trim();if(!secret)return res.status(503).json({ok:false,error:'messenger_app_secret_missing'});
    const signature=String(req.header('X-Hub-Signature-256')||'').replace(/^sha256=/i,'').trim().toLowerCase();
    const expected=crypto.createHmac('sha256',secret).update(rawBody(req)).digest('hex');
    if(!safeEqualHex(signature,expected))return res.status(401).json({ok:false,error:'invalid_meta_signature'});
    await ensureSchema();
    if(String(req.body?.object||'')!=='page')return res.status(200).send('EVENT_RECEIVED');
    for(const entry of Array.isArray(req.body?.entry)?req.body.entry:[]){
      const pageId=String(entry?.id||process.env.MESSENGER_PAGE_ID||'').trim();const scope=await resolveScope('messenger',pageId);if(!scope)continue;
      for(const evt of Array.isArray(entry?.messaging)?entry.messaging:[]){
        const psid=String(evt?.sender?.id||'').trim();if(!psid)continue;
        const clientHint=parseClientHint(evt?.postback?.referral?.ref,evt?.referral?.ref,evt?.postback?.payload);
        const ident=await upsertIdentity(scope,'messenger',psid,null,clientHint,false,{page_id:pageId,last_event_at:new Date(Number(evt?.timestamp)||Date.now()).toISOString()});
        if(evt?.message){const text=String(evt.message.text||'').trim();if(text)await ingestInbound(scope,'messenger',psid,text,String(evt.message.mid||'')||null,evt,ident.client_id||null);}
        if(evt?.postback){const body=String(evt.postback.title||evt.postback.payload||'').trim();if(body)await ingestInbound(scope,'messenger',psid,body,null,evt,ident.client_id||null);const touchId=parseTouchHint(evt.postback.payload);if(touchId)await pool.query(`UPDATE vir_communication_touches SET clicked_at=COALESCE(clicked_at,now()),status=CASE WHEN status='failed' THEN status ELSE 'clicked' END WHERE id=$1::uuid AND tenant_id=$2::uuid`,[touchId,scope.tenantId]);}
        if(evt?.delivery){for(const mid of Array.isArray(evt.delivery.mids)?evt.delivery.mids:[])await updateTouchByProviderMessage('messenger',String(mid),'delivered');}
        if(evt?.read){const watermark=new Date(Number(evt.read.watermark)||Date.now());await pool.query(`UPDATE vir_communication_touches SET status=CASE WHEN status='failed' THEN status ELSE 'read' END,delivered_at=COALESCE(delivered_at,sent_at),read_at=COALESCE(read_at,$4::timestamptz) WHERE tenant_id=$1::uuid AND channel='messenger' AND recipient_external_id=$2 AND sent_at IS NOT NULL AND sent_at<=$4::timestamptz`,[scope.tenantId,psid,pageId,watermark.toISOString()]);}
      }
    }
    return res.status(200).send('EVENT_RECEIVED');
  }catch(e:any){console.error('Meta webhook error',e?.message||e);return res.status(500).json({ok:false,error:'meta_webhook_failed'});}
});

export default router;
