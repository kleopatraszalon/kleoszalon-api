import db from "../db";

const STRIPE_API_BASE="https://api.stripe.com/v1";
const DAY_MS=86400000;

type StripeObject=Record<string,any>;
type PlanRow={id:string|number;code:string;name:string;monthly_price:number|string;annual_price?:number|string|null;currency?:string;trial_days?:number|null};

function secretKey(){return String(process.env.STRIPE_SECRET_KEY||"").trim();}
function requireStripe(){const key=secretKey();if(!key){const error:any=new Error("A Stripe nincs konfigurálva.");error.code="STRIPE_NOT_CONFIGURED";throw error;}return key;}
function frontendBase(){return String(process.env.SAAS_FRONTEND_URL||"https://kleoszalon-frontend.onrender.com").replace(/\/$/,"");}
function toMinor(amount:number){return Math.round(amount*100);}
function fromMinor(amount:any){const n=Number(amount||0);return Number.isFinite(n)?n/100:0;}
function unixDate(value:any){const n=Number(value||0);return Number.isFinite(n)&&n>0?new Date(n*1000):null;}
function append(params:URLSearchParams,key:string,value:any){if(value===undefined||value===null||value==="")return;params.append(key,String(value));}

async function stripeRequest(path:string,method:"GET"|"POST"="GET",params?:URLSearchParams,idempotencyKey?:string){
 const key=requireStripe();
 const headers:Record<string,string>={Authorization:`Bearer ${key}`};
 if(idempotencyKey)headers["Idempotency-Key"]=idempotencyKey;
 const init:RequestInit={method,headers};
 if(method==="POST"){headers["Content-Type"]="application/x-www-form-urlencoded";init.body=params?.toString()||"";}
 const response=await fetch(`${STRIPE_API_BASE}${path}`,init);
 const payload:any=await response.json().catch(()=>({}));
 if(!response.ok){const error:any=new Error(payload?.error?.message||`Stripe API hiba (${response.status})`);error.code=payload?.error?.code||"STRIPE_API_ERROR";error.status=response.status;throw error;}
 return payload;
}

export function stripeBillingReadiness(){
 const key=secretKey();
 const automaticTax=process.env.STRIPE_AUTOMATIC_TAX==="1";
 const taxRateId=String(process.env.STRIPE_TAX_RATE_ID||"").trim();
 return{configured:Boolean(key),mode:key.startsWith("sk_live_")?"live":key.startsWith("sk_test_")?"test":"unknown",tax_configured:automaticTax||Boolean(taxRateId),automatic_tax:automaticTax,portal_return_url:String(process.env.SAAS_BILLING_PORTAL_RETURN_URL||`${frontendBase()}/admin/saas`),webhook_verification:"stripe_event_retrieval"};
}

export async function createStripeCheckout(input:{tenantId:string;tenantName:string;billingEmail?:string|null;externalCustomerId?:string|null;plan:PlanRow;billingInterval:"month"|"year";couponPercent?:number|null}){
 const readiness=stripeBillingReadiness();if(!readiness.configured){const e:any=new Error("A Stripe nincs konfigurálva.");e.code="STRIPE_NOT_CONFIGURED";throw e;}
 if(process.env.NODE_ENV==="production"&&!readiness.tax_configured){const e:any=new Error("A nettó SaaS árakhoz Stripe Tax vagy tax rate konfiguráció szükséges.");e.code="STRIPE_TAX_NOT_CONFIGURED";throw e;}
 const amount=input.billingInterval==="year"?Number(input.plan.annual_price||0):Number(input.plan.monthly_price||0);
 if(!Number.isFinite(amount)||amount<=0){const e:any=new Error("A kiválasztott csomag ára nincs beállítva.");e.code="PLAN_PRICE_NOT_CONFIGURED";throw e;}
 const params=new URLSearchParams();
 append(params,"mode","subscription");append(params,"success_url",String(process.env.SAAS_BILLING_SUCCESS_URL||`${frontendBase()}/admin/saas?billing=success&session_id={CHECKOUT_SESSION_ID}`));append(params,"cancel_url",String(process.env.SAAS_BILLING_CANCEL_URL||`${frontendBase()}/admin/saas?billing=cancelled`));
 append(params,"billing_address_collection","required");append(params,"client_reference_id",input.tenantId);append(params,"metadata[tenant_id]",input.tenantId);append(params,"metadata[plan_code]",input.plan.code);append(params,"metadata[billing_interval]",input.billingInterval);
 append(params,"subscription_data[metadata][tenant_id]",input.tenantId);append(params,"subscription_data[metadata][plan_code]",input.plan.code);append(params,"subscription_data[metadata][billing_interval]",input.billingInterval);
 if(input.externalCustomerId)append(params,"customer",input.externalCustomerId);else if(input.billingEmail)append(params,"customer_email",input.billingEmail);
 append(params,"line_items[0][quantity]",1);append(params,"line_items[0][price_data][currency]",String(input.plan.currency||"HUF").toLowerCase());append(params,"line_items[0][price_data][unit_amount]",toMinor(amount));append(params,"line_items[0][price_data][product_data][name]",`KleoSaaS ${input.plan.name}`);append(params,"line_items[0][price_data][product_data][metadata][plan_code]",input.plan.code);append(params,"line_items[0][price_data][recurring][interval]",input.billingInterval);
 if(process.env.STRIPE_AUTOMATIC_TAX==="1")append(params,"automatic_tax[enabled]","true");else append(params,"line_items[0][tax_rates][0]",String(process.env.STRIPE_TAX_RATE_ID||"").trim());
 if(input.couponPercent&&input.couponPercent>0){const couponParams=new URLSearchParams();append(couponParams,"percent_off",Math.min(100,input.couponPercent));append(couponParams,"duration","once");append(couponParams,"name",`KleoSaaS kedvezmény ${input.couponPercent}%`);const coupon=await stripeRequest("/coupons","POST",couponParams,`kleo-coupon-${input.tenantId}-${input.plan.code}-${input.couponPercent}`);append(params,"discounts[0][coupon]",coupon.id);}
 return stripeRequest("/checkout/sessions","POST",params,`kleo-checkout-${input.tenantId}-${input.plan.code}-${input.billingInterval}-${Date.now()}`);
}

export async function createStripePortal(externalCustomerId:string){
 if(!externalCustomerId){const e:any=new Error("Nincs Stripe customer azonosító.");e.code="STRIPE_CUSTOMER_MISSING";throw e;}
 const params=new URLSearchParams();append(params,"customer",externalCustomerId);append(params,"return_url",String(process.env.SAAS_BILLING_PORTAL_RETURN_URL||`${frontendBase()}/admin/saas`));
 return stripeRequest("/billing_portal/sessions","POST",params);
}

export async function retrieveStripeEvent(eventId:string){
 if(!/^evt_[A-Za-z0-9]+$/.test(eventId)){const e:any=new Error("Érvénytelen Stripe event azonosító.");e.code="STRIPE_EVENT_INVALID";throw e;}
 return stripeRequest(`/events/${encodeURIComponent(eventId)}`);
}

function statusMap(value:any){const s=String(value||"").toLowerCase();if(s==="trialing")return"trial";if(s==="active")return"active";if(["past_due","unpaid","incomplete","incomplete_expired","paused"].includes(s))return"past_due";if(["canceled","cancelled"].includes(s))return"cancelled";return s||"active";}
async function resolveTenant(client:any,obj:StripeObject){
 const metadata=obj?.metadata||obj?.subscription_details?.metadata||obj?.parent?.subscription_details?.metadata||{};const metadataTenant=String(metadata?.tenant_id||"").trim();if(/^\d+$/.test(metadataTenant))return metadataTenant;
 const subscriptionId=typeof obj?.subscription==="string"?obj.subscription:obj?.subscription?.id||obj?.parent?.subscription_details?.subscription||null;
 if(subscriptionId){const r=await client.query(`SELECT tenant_id::text FROM subscriptions WHERE billing_provider='stripe' AND external_subscription_id=$1 LIMIT 1`,[subscriptionId]);if(r.rows[0])return String(r.rows[0].tenant_id);}
 const customerId=typeof obj?.customer==="string"?obj.customer:obj?.customer?.id||null;if(customerId){const r=await client.query(`SELECT tenant_id::text FROM subscriptions WHERE billing_provider='stripe' AND external_customer_id=$1 ORDER BY created_at DESC LIMIT 1`,[customerId]);if(r.rows[0])return String(r.rows[0].tenant_id);}
 return null;
}
async function currentSubscription(client:any,tenantId:string){return(await client.query(`SELECT id,tenant_id,plan_id,status FROM subscriptions WHERE tenant_id=$1::bigint ORDER BY CASE WHEN status IN('trial','active','past_due','suspended') THEN 0 ELSE 1 END,created_at DESC LIMIT 1 FOR UPDATE`,[tenantId])).rows[0]||null;}

export async function processStripeEvent(event:StripeObject){
 const eventId=String(event?.id||"");const eventType=String(event?.type||"");if(!eventId||!eventType)throw new Error("Hiányos Stripe event.");
 const client=await db.connect();
 try{
  await client.query("BEGIN");
  const inserted=await client.query(`INSERT INTO billing_webhook_events(provider,external_event_id,event_type,payload,processing_status) VALUES('stripe',$1,$2,$3::jsonb,'received') ON CONFLICT(provider,external_event_id) DO NOTHING RETURNING id`,[eventId,eventType,JSON.stringify(event)]);
  if(!inserted.rowCount){await client.query("ROLLBACK");return{ok:true,duplicate:true,event_id:eventId};}
  const obj=event?.data?.object||{};const tenantId=await resolveTenant(client,obj);if(!tenantId){await client.query(`UPDATE billing_webhook_events SET processing_status='ignored',error_message='tenant_not_resolved',processed_at=now() WHERE provider='stripe' AND external_event_id=$1`,[eventId]);await client.query("COMMIT");return{ok:true,ignored:true,event_id:eventId};}
  await client.query(`UPDATE billing_webhook_events SET tenant_id=$2::bigint WHERE provider='stripe' AND external_event_id=$1`,[eventId,tenantId]);
  const sub=await currentSubscription(client,tenantId);if(!sub)throw new Error("A Stripe eventhez nem található helyi előfizetés.");
  if(eventType==="checkout.session.completed"){
   const customerId=typeof obj.customer==="string"?obj.customer:obj.customer?.id||null;const externalSubscriptionId=typeof obj.subscription==="string"?obj.subscription:obj.subscription?.id||null;const interval=String(obj.metadata?.billing_interval||"month");const planCode=String(obj.metadata?.plan_code||"");
   let planId=sub.plan_id;if(planCode){const p=await client.query(`SELECT id FROM subscription_plans WHERE code=$1 LIMIT 1`,[planCode]);if(p.rows[0])planId=p.rows[0].id;}
   await client.query(`UPDATE subscriptions SET plan_id=$2,billing_provider='stripe',external_customer_id=COALESCE($3,external_customer_id),external_subscription_id=COALESCE($4,external_subscription_id),billing_interval=$5,status=CASE WHEN status='cancelled' THEN 'active' ELSE status END,last_payment_status=CASE WHEN $6 IN('paid','no_payment_required') THEN 'paid' ELSE last_payment_status END,last_payment_at=CASE WHEN $6 IN('paid','no_payment_required') THEN now() ELSE last_payment_at END,updated_at=now() WHERE id=$1`,[sub.id,planId,customerId,externalSubscriptionId,interval,String(obj.payment_status||"")]);
  }else if(eventType.startsWith("customer.subscription.")){
   const mapped=eventType==="customer.subscription.deleted"?"cancelled":statusMap(obj.status);const periodEnd=unixDate(obj.current_period_end);await client.query(`UPDATE subscriptions SET billing_provider='stripe',external_customer_id=COALESCE($3,external_customer_id),external_subscription_id=COALESCE($4,external_subscription_id),status=$2,current_period_end=$5,cancel_at_period_end=COALESCE($6,false),cancelled_at=CASE WHEN $2='cancelled' THEN COALESCE(cancelled_at,now()) ELSE NULL END,updated_at=now() WHERE id=$1`,[sub.id,mapped,typeof obj.customer==="string"?obj.customer:null,obj.id||null,periodEnd,obj.cancel_at_period_end]);
  }else if(eventType==="invoice.paid"||eventType==="invoice.payment_succeeded"){
   const invoiceId=String(obj.id||"");const periodStart=unixDate(obj.period_start);const periodEnd=unixDate(obj.period_end);const paidAt=unixDate(obj.status_transitions?.paid_at)||new Date();const total=fromMinor(obj.total);const tax=fromMinor(obj.tax);const net=Math.max(0,total-tax);
   if(invoiceId)await client.query(`INSERT INTO subscription_invoices(tenant_id,subscription_id,period_start,period_end,currency,net_amount,tax_amount,gross_amount,status,due_at,paid_at,external_invoice_id,provider_payload) VALUES($1::bigint,$2,$3,$4,$5,$6,$7,$8,'paid',$9,$10,$11,$12::jsonb) ON CONFLICT(external_invoice_id) DO UPDATE SET status='paid',paid_at=EXCLUDED.paid_at,net_amount=EXCLUDED.net_amount,tax_amount=EXCLUDED.tax_amount,gross_amount=EXCLUDED.gross_amount,provider_payload=EXCLUDED.provider_payload,updated_at=now()`,[tenantId,sub.id,periodStart,periodEnd,String(obj.currency||"HUF").toUpperCase(),net,tax,total,unixDate(obj.due_date),paidAt,invoiceId,JSON.stringify(obj)]);
   await client.query(`UPDATE subscriptions SET status='active',last_payment_status='paid',last_payment_at=now(),grace_period_end=NULL,next_retry_at=NULL,dunning_step=0,payment_method_status='valid',updated_at=now() WHERE id=$1`,[sub.id]);await client.query(`UPDATE tenants SET status='active',updated_at=now() WHERE id=$1::bigint AND status='suspended'`,[tenantId]);
  }else if(eventType==="invoice.payment_failed"){
   const invoiceId=String(obj.id||"");const total=fromMinor(obj.total);if(invoiceId)await client.query(`INSERT INTO subscription_invoices(tenant_id,subscription_id,currency,gross_amount,status,due_at,external_invoice_id,provider_payload) VALUES($1::bigint,$2,$3,$4,'open',$5,$6,$7::jsonb) ON CONFLICT(external_invoice_id) DO UPDATE SET status='open',provider_payload=EXCLUDED.provider_payload,updated_at=now()`,[tenantId,sub.id,String(obj.currency||"HUF").toUpperCase(),total,unixDate(obj.due_date),invoiceId,JSON.stringify(obj)]);
   await client.query(`UPDATE subscriptions SET status='past_due',last_payment_status='failed',grace_period_end=COALESCE(grace_period_end,now()+interval '7 days'),next_retry_at=now()+interval '1 day',dunning_step=LEAST(COALESCE(dunning_step,0)+1,4),payment_method_status='attention_required',updated_at=now() WHERE id=$1`,[sub.id]);
  }
  await client.query(`INSERT INTO subscription_events(tenant_id,subscription_id,event_type,source,external_event_id,payload) VALUES($1::bigint,$2,$3,'stripe',$4,$5::jsonb) ON CONFLICT(source,external_event_id) DO NOTHING`,[tenantId,sub.id,eventType,eventId,JSON.stringify({stripe_object_id:obj.id||null})]);
  await client.query(`UPDATE billing_webhook_events SET processing_status='processed',processed_at=now() WHERE provider='stripe' AND external_event_id=$1`,[eventId]);await client.query("COMMIT");return{ok:true,event_id:eventId,event_type:eventType,tenant_id:tenantId};
 }catch(error:any){await client.query("ROLLBACK").catch(()=>{});await db.query(`INSERT INTO billing_webhook_events(provider,external_event_id,event_type,processing_status,payload,error_message,processed_at) VALUES('stripe',$1,$2,'failed',$3::jsonb,$4,now()) ON CONFLICT(provider,external_event_id) DO UPDATE SET processing_status='failed',error_message=EXCLUDED.error_message,processed_at=now()`,[eventId,eventType,JSON.stringify(event),String(error?.message||error).slice(0,1000)]).catch(()=>{});throw error;}finally{client.release();}
}

export async function runRevenueDunningCycle(){
 const client=await db.connect();try{await client.query("BEGIN");const due=await client.query(`SELECT s.id,s.tenant_id,t.name,t.billing_email,s.dunning_step,s.grace_period_end FROM subscriptions s JOIN tenants t ON t.id=s.tenant_id WHERE s.status='past_due' AND s.grace_period_end IS NOT NULL AND s.grace_period_end<=now() FOR UPDATE SKIP LOCKED`);let suspended=0;for(const row of due.rows){await client.query(`UPDATE subscriptions SET status='suspended',payment_method_status='attention_required',updated_at=now() WHERE id=$1`,[row.id]);await client.query(`UPDATE tenants SET status='suspended',updated_at=now() WHERE id=$1`,[row.tenant_id]);await client.query(`INSERT INTO subscription_events(tenant_id,subscription_id,event_type,source,payload) VALUES($1,$2,'dunning_suspended','revenue_engine',$3::jsonb)`,[row.tenant_id,row.id,JSON.stringify({grace_period_end:row.grace_period_end,dunning_step:row.dunning_step})]);suspended++;}await client.query("COMMIT");return{checked:due.rowCount||0,suspended};}catch(error){await client.query("ROLLBACK").catch(()=>{});throw error;}finally{client.release();}
}
