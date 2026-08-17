import db from '../db';

type Queryable={query:(sql:string,params?:any[])=>Promise<any>};
export type DailyActionContext={locationId?:string|null;clientId?:string|null;at?:Date|string|null};
export type ApplicableDailyAction={id:string;headline:string;description_html:string;image_url:string|null;cta_label:string|null;cta_url:string|null;discount_text:string|null;discount_percent:number;valid_from:string;valid_until:string;location_id:string|null;service_id:string|null;audience:any};

let schemaReady:Promise<void>|null=null;
export function ensureDailyActionApplicabilitySchema(q:Queryable=db):Promise<void>{
 if(q!==db)return ensureSchema(q);
 if(schemaReady)return schemaReady;
 schemaReady=ensureSchema(q).catch(error=>{schemaReady=null;throw error});
 return schemaReady;
}
async function ensureSchema(q:Queryable){
 // Keep this migration compatible with both the canonical UUID schema and
 // older production databases. In particular, do not attach a FK while the
 // legacy locations.id type may still differ from UUID.
 await q.query(`ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS location_id uuid`);
 await q.query(`ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS service_id uuid`);
 await q.query(`ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS discount_percent numeric(5,2)`);
 await q.query(`ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS auto_selector_meta jsonb DEFAULT '{}'::jsonb`);
 await q.query(`CREATE INDEX IF NOT EXISTS daily_action_campaigns_applicability_idx ON daily_action_campaigns(status,location_id,valid_from,valid_until)`);
}
const text=(v:any)=>String(v??'').trim();
const number=(v:any,fallback=0)=>{const n=Number(v);return Number.isFinite(n)?n:fallback};
function atValue(at:DailyActionContext['at']){const d=at instanceof Date?at:new Date(at||Date.now());return Number.isNaN(d.getTime())?new Date():d}
function legacyPercent(row:any){
 if(row.discount_percent!==null&&row.discount_percent!==undefined&&text(row.discount_percent)!=='')return number(row.discount_percent,0);
 const rawMeta=row.auto_selector_meta?.applied_discount_pct;
 if(rawMeta!==null&&rawMeta!==undefined&&text(rawMeta)!=='')return number(rawMeta,0);
 const match=text(row.discount_text).match(/(\d+(?:[.,]\d+)?)\s*%/);
 return match?number(match[1].replace(',','.'),0):0;
}
function normalizedLocation(row:any){return text(row.location_id||row.auto_selector_meta?.location_id)||null}

async function audienceEligible(q:Queryable,audience:any,clientId:string|null,at:Date){
 const type=text(audience?.type||'all').toLowerCase();
 if(type==='all')return true;
 if(!clientId)return false;
 const client=(await q.query(`SELECT c.* FROM clients c WHERE c.id::text=$1 LIMIT 1`,[clientId])).rows[0];
 if(!client)return false;
 if(type==='new'){
  const days=Math.max(1,Math.min(365,number(audience?.days,30)));
  return new Date(client.created_at||0).getTime()>=at.getTime()-days*86400000;
 }
 if(type==='inactive'){
  const days=Math.max(1,Math.min(3650,number(audience?.days,180)));
  const last=new Date(client.altegio_last_visit||client.updated_at||client.created_at||0).getTime();
  return last<at.getTime()-days*86400000;
 }
 if(type==='loyalty'){
  const tiers=Array.isArray(audience?.tiers)&&audience.tiers.length?audience.tiers.map((x:any)=>text(x)).filter(Boolean):['gold'];
  const r=await q.query(`SELECT 1 FROM loyalty_program_members pm WHERE pm.client_id::text=$1 AND pm.tier_code=ANY($2::text[]) LIMIT 1`,[clientId,tiers]);
  return Boolean(r.rows[0]);
 }
 if(type==='pass_holders'){
  const r=await q.query(`SELECT 1 FROM loyalty_accounts la JOIN loyalty_passes lp ON lp.account_id=la.id WHERE la.customer_id::text=$1 AND lp.status='active' LIMIT 1`,[clientId]);
  return Boolean(r.rows[0]);
 }
 return false;
}

export async function applicableDailyActions(q:Queryable,context:DailyActionContext={}):Promise<ApplicableDailyAction[]>{
 await ensureDailyActionApplicabilitySchema(q);
 const locationId=text(context.locationId)||null,clientId=text(context.clientId)||null,at=atValue(context.at);
 const {rows}=await q.query(`
  SELECT d.id::text,d.headline,d.description_html,d.image_url,d.cta_label,d.cta_url,d.discount_text,
         d.discount_percent,d.valid_from,d.valid_until,d.location_id::text,d.service_id::text,d.audience,
         COALESCE(to_jsonb(d)->'auto_selector_meta','{}'::jsonb) AS auto_selector_meta
    FROM daily_action_campaigns d
   WHERE d.status='published'
     AND d.valid_from<=$1::timestamptz AND d.valid_until>=$1::timestamptz
     AND (
       (d.location_id IS NULL AND COALESCE(to_jsonb(d)->'auto_selector_meta'->>'location_id','')='')
       OR d.location_id::text=$2
       OR to_jsonb(d)->'auto_selector_meta'->>'location_id'=$2
     )
   ORDER BY d.valid_until,d.id
 `,[at.toISOString(),locationId]);
 const out:ApplicableDailyAction[]=[];
 for(const row of rows){
  if(!(await audienceEligible(q,row.audience,clientId,at)))continue;
  out.push({...row,location_id:normalizedLocation(row),discount_percent:Math.max(0,Math.min(100,legacyPercent(row)))})
 }
 return out;
}

export async function dailyActionDiscountForWorkOrder(q:Queryable,workOrderId:string,gross:number){
 await ensureDailyActionApplicabilitySchema(q);
 const wo=(await q.query(`SELECT id::text,location_id::text,client_id::text FROM work_orders WHERE id::text=$1 LIMIT 1`,[workOrderId])).rows[0];
 if(!wo)return{amount:0,percent:0,campaign_id:null as string|null,service_id:null as string|null};
 const actions=await applicableDailyActions(q,{locationId:wo.location_id,clientId:wo.client_id,at:new Date()});
 let best={amount:0,percent:0,campaign_id:null as string|null,service_id:null as string|null};
 for(const action of actions){
  const pct=Math.max(0,Math.min(100,number(action.discount_percent)));
  if(!(pct>0))continue;
  let base=Math.max(0,number(gross));
  if(action.service_id){
   const r=await q.query(`SELECT COALESCE(SUM(line_total),0)::numeric base FROM work_order_items WHERE work_order_id::text=$1 AND service_id::text=$2`,[workOrderId,action.service_id]);
   base=Math.max(0,number(r.rows[0]?.base));
  }
  const amount=Math.round(base*pct)/100;
  if(amount>best.amount)best={amount,percent:pct,campaign_id:action.id,service_id:action.service_id};
 }
 return best;
}