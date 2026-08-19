import db from "../db";

let schemaReady:Promise<void>|null=null;
export async function ensureSelfServiceSignupSchema(){
 if(!schemaReady){schemaReady=db.query(`
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE TABLE IF NOT EXISTS tenant_onboarding (
    tenant_id bigint PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'in_progress' CHECK(status IN('in_progress','blocked','ready')),
    current_step text NOT NULL DEFAULT 'company',
    started_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    created_by text,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS tenant_onboarding_events (
    id bigserial PRIMARY KEY,
    tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    step_key text NOT NULL,
    event_type text NOT NULL,
    actor_user_id text,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS tenant_onboarding_events_tenant_idx ON tenant_onboarding_events(tenant_id,created_at DESC);
  CREATE TABLE IF NOT EXISTS saas_self_service_signups(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_key text NOT NULL UNIQUE,
    tenant_id bigint NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
    plan_code text NOT NULL,
    billing_interval text NOT NULL DEFAULT 'month' CHECK(billing_interval IN('month','year')),
    owner_email text NOT NULL,
    ip_hash text,
    status text NOT NULL DEFAULT 'pending_activation' CHECK(status IN('pending_activation','invited','active','invite_failed','expired','cancelled')),
    terms_version text NOT NULL,
    privacy_version text NOT NULL,
    marketing_consent boolean NOT NULL DEFAULT false,
    activation_expires_at timestamptz NOT NULL DEFAULT now()+interval '48 hours',
    invited_at timestamptz,
    activated_at timestamptz,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS saas_self_service_email_idx ON saas_self_service_signups(lower(owner_email),created_at DESC);
  CREATE INDEX IF NOT EXISTS saas_self_service_ip_idx ON saas_self_service_signups(ip_hash,created_at DESC) WHERE ip_hash IS NOT NULL;
 `).then(()=>undefined).catch(error=>{schemaReady=null;throw error});}
 await schemaReady;
}

export async function activateSelfServiceTrial(client:any,tenantId:string,actorUserId:string|null){
 await ensureSelfServiceSignupSchema();
 const signup=await client.query(`SELECT id::text,plan_code,status FROM saas_self_service_signups WHERE tenant_id=$1::bigint FOR UPDATE`,[tenantId]);
 const row=signup.rows[0];if(!row||row.status==='active')return false;
 const sub=await client.query(`SELECT s.id,sp.trial_days FROM subscriptions s JOIN subscription_plans sp ON sp.id=s.plan_id WHERE s.tenant_id=$1::bigint ORDER BY s.created_at DESC LIMIT 1 FOR UPDATE`,[tenantId]);
 if(!sub.rows[0])return false;
 const trialDays=Math.max(1,Number(sub.rows[0].trial_days||14));
 await client.query(`UPDATE subscriptions SET status='trial',starts_at=now(),trial_ends_at=now()+($2::text||' days')::interval,current_period_end=NULL,grace_period_end=NULL,cancel_at_period_end=false,cancelled_at=NULL,updated_at=now() WHERE id=$1`,[sub.rows[0].id,String(trialDays)]);
 await client.query(`UPDATE tenants SET status='active',updated_at=now() WHERE id=$1::bigint`,[tenantId]);
 await client.query(`UPDATE saas_self_service_signups SET status='active',activated_at=now(),last_error=NULL,updated_at=now() WHERE tenant_id=$1::bigint`,[tenantId]);
 await client.query(`INSERT INTO subscription_events(tenant_id,subscription_id,event_type,source,payload) VALUES($1::bigint,$2,'self_service_trial_started','self_service',$3::jsonb)`,[tenantId,sub.rows[0].id,JSON.stringify({trial_days:trialDays,activated_by:actorUserId})]);
 await client.query(`INSERT INTO tenant_onboarding_events(tenant_id,step_key,event_type,actor_user_id,payload) VALUES($1::bigint,'subscription','self_service_trial_started',$2,$3::jsonb)`,[tenantId,actorUserId,JSON.stringify({trial_days:trialDays,plan_code:row.plan_code})]);
 return true;
}

export async function expireStaleSelfServiceSignups(){
 await ensureSelfServiceSignupSchema();
 const result=await db.query(`UPDATE saas_self_service_signups SET status='expired',updated_at=now() WHERE status IN('pending_activation','invited','invite_failed') AND activation_expires_at<=now() RETURNING tenant_id::text`);
 if(result.rowCount)await db.query(`UPDATE tenants SET status='suspended',updated_at=now() WHERE id=ANY($1::bigint[]) AND status='pending_activation'`,[result.rows.map((r:any)=>r.tenant_id)]).catch(()=>undefined);
 return result.rowCount||0;
}
