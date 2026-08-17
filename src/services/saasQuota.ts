import db from '../db';

export type SaasQuotaResource='locations'|'users';
export type SaasQuotaSnapshot={tenant_id:string;plan_code:string|null;plan_name:string|null;resource:SaasQuotaResource;used:number;limit:number|null;remaining:number|null;usage_percent:number|null;unlimited:boolean;};

function quotaColumn(resource:SaasQuotaResource){return resource==='locations'?'max_locations':'max_users';}
async function usageCount(client:any,tenantId:string,resource:SaasQuotaResource){
  if(resource==='locations'){
    const {rows}=await client.query(`SELECT count(*)::int used FROM locations WHERE tenant_id=$1::bigint AND COALESCE(is_active,true)=true`,[tenantId]);
    return Number(rows[0]?.used||0);
  }
  const {rows}=await client.query(`SELECT count(*)::int used FROM tenant_users WHERE tenant_id=$1::bigint AND active=true`,[tenantId]);
  return Number(rows[0]?.used||0);
}

export async function getTenantQuota(tenantId:string,resource:SaasQuotaResource,client:any=db):Promise<SaasQuotaSnapshot>{
  const column=quotaColumn(resource);
  const {rows}=await client.query(`SELECT sp.code plan_code,sp.name plan_name,sp.${column} quota_limit
    FROM subscriptions s JOIN subscription_plans sp ON sp.id=s.plan_id
    WHERE s.tenant_id=$1::bigint
    ORDER BY CASE WHEN s.status IN ('trial','active','past_due','suspended') THEN 0 ELSE 1 END,s.created_at DESC LIMIT 1`,[tenantId]);
  const plan=rows[0]||{};const used=await usageCount(client,tenantId,resource);const limit=plan.quota_limit==null?null:Number(plan.quota_limit);const unlimited=limit==null;
  return{tenant_id:String(tenantId),plan_code:plan.plan_code||null,plan_name:plan.plan_name||null,resource,used,limit,remaining:unlimited?null:Math.max(0,limit-used),usage_percent:unlimited?null:(limit===0?(used>0?100:0):Math.round((used/limit)*100)),unlimited};
}

export async function assertTenantQuota(tenantId:string,resource:SaasQuotaResource,increment=1,client:any=db){
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`saas_quota:${resource}:${tenantId}`]);
  const quota=await getTenantQuota(tenantId,resource,client);
  if(!quota.unlimited&&quota.used+Math.max(0,Number(increment)||0)>Number(quota.limit)){
    const error:any=new Error(resource==='locations'?`A csomag telephelylimitje elérve (${quota.used}/${quota.limit}).`:`A csomag felhasználói limitje elérve (${quota.used}/${quota.limit}).`);
    error.code='SAAS_QUOTA_EXCEEDED';error.status=409;error.resource=resource;error.quota=quota;throw error;
  }
  return quota;
}

export async function getTenantUsage(tenantId:string,client:any=db){
  const [locations,users]=await Promise.all([getTenantQuota(tenantId,'locations',client),getTenantQuota(tenantId,'users',client)]);
  return{locations,users,near_limit:[locations,users].some(q=>!q.unlimited&&Number(q.usage_percent)>=80),exceeded:[locations,users].some(q=>!q.unlimited&&q.used>Number(q.limit))};
}
