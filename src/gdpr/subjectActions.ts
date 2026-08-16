import { createHash } from "crypto";

type Queryable={query:(sql:string,params?:any[])=>Promise<any>};

const qid=(name:string)=>`"${name.replace(/"/g,'""')}"`;
const SCRUB_RULES:Record<string,Record<string,string>>={
  appointments:{client_name:"'Anonimizált ügyfél'",client_phone:"NULL",client_email:"NULL",notes:"NULL",cancellation_reason:"NULL",cancellation_note:"NULL",no_show_reason:"NULL"},
  booking_waitlist:{client_name:"'Anonimizált ügyfél'",phone:"NULL",email:"NULL",note:"NULL"},
  work_orders:{client_name:"'Anonimizált ügyfél'",client_phone:"NULL",client_email:"NULL",notes:"NULL",record_note:"NULL",client_first_name:"NULL",client_last_name:"NULL",source_snapshot:"'{}'::jsonb"},
  crm_client_notes:{note_text:"'[anonimizált GDPR-adat]'"},
  crm_form_responses:{response_data:"'{\"anonymized\":true}'::jsonb"},
  booking_communication_queue:{recipient:"'[anonimizált]'",body_text:"'[anonimizált]'",body_html:"NULL",error_text:"NULL"},
  newsletter_deliveries:{email:"NULL",error:"NULL"},
  customer_self_service_log:{before_data:"'{\"anonymized\":true}'::jsonb",after_data:"'{\"anonymized\":true}'::jsonb",note:"NULL"},
  client_booking_controls:{block_reason:"NULL"},
  app_push_subscriptions:{endpoint:"'gdpr:'||id::text",subscription:"'{}'::jsonb",active:"false"},
  clients:{full_name:"'Anonimizált ügyfél'",name:"'Anonimizált ügyfél'",phone:"NULL",email:"NULL",birth_date:"NULL",gender:"NULL",city:"NULL",address:"NULL",notes:"NULL",barcode:"NULL",profile_image_url:"NULL",additional_phones:"NULL",preferred_employee_id:"NULL",merged_into_client_id:"NULL",merge_note:"NULL",marketing_consent:"false",email_consent:"false",sms_consent:"false",phone_consent:"false",consent_source:"NULL",privacy_notice_version:"NULL",is_active:"false",gdpr_erased_at:"now()"},
};
const PRESERVE_LINK=new Set(["crm_consent_history","crm_form_responses","crm_client_notes"]);

async function columns(db:Queryable,table:string){return(await db.query(`SELECT column_name,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,[table])).rows as Array<{column_name:string;is_nullable:string}>}
async function scrubTable(db:Queryable,table:string,subjectId:string,requestId:string){
  const meta=await columns(db,table);if(!meta.length)return 0;const names=new Set(meta.map(row=>row.column_name)),rules=SCRUB_RULES[table]||{};
  const assignments=Object.entries(rules).filter(([column])=>names.has(column)).map(([column,expression])=>`${qid(column)}=${expression}`);
  if(table==="clients"&&names.has("gdpr_erasure_request_id"))assignments.push(`${qid("gdpr_erasure_request_id")}=$2::uuid`);
  if(names.has("updated_at"))assignments.push(`${qid("updated_at")}=now()`);
  if(!assignments.length)return 0;
  const link=table==="clients"?"id":names.has("client_id")?"client_id":names.has("customer_id")?"customer_id":null;if(!link)return 0;
  const hasInvoices=table==="work_orders"&&Boolean((await db.query(`SELECT to_regclass('public.finance_invoices') rel`)).rows[0]?.rel),financialPreserve=table==="work_orders"?` AND NOT (COALESCE((to_jsonb(${qid(table)})->>'fully_paid')::boolean,false) OR lower(COALESCE(to_jsonb(${qid(table)})->>'status','')) IN ('completed','closed','finalized','paid')${hasInvoices?` OR EXISTS(SELECT 1 FROM finance_invoices i WHERE i.work_order_id::text=${qid(table)}.id::text)`:""})`:"";
  const result=await db.query(`UPDATE ${qid(table)} SET ${assignments.join(",")} WHERE ${qid(link)}::text=$1${financialPreserve}`,table==="clients"?[subjectId,requestId]:[subjectId]);return Number(result.rowCount||0);
}

async function scrubContactDuplicates(db:Queryable,root:any){
  const affected:Record<string,number>={},email=String(root?.email||"").trim().toLowerCase(),phone=String(root?.phone||"").replace(/\D/g,"");
  const users=await columns(db,"users");if(users.length&&(email||phone)){const names=new Set(users.map(x=>x.column_name)),nullable=new Map(users.map(x=>[x.column_name,x.is_nullable==="YES"])),set:string[]=[];if(names.has("full_name"))set.push(`full_name='Anonimizált ügyfél'`);if(names.has("name"))set.push(`name='Anonimizált ügyfél'`);if(names.has("email"))set.push(`email='gdpr-erased-'||id::text||'@invalid.local'`);if(names.has("phone"))set.push(`phone=${nullable.get("phone")?"NULL":"''"}`);if(names.has("login_name"))set.push(`login_name='gdpr-erased-'||id::text`);if(names.has("password_hash"))set.push(`password_hash=md5(random()::text||clock_timestamp()::text)`);if(names.has("active"))set.push(`active=false`);if(names.has("updated_at"))set.push(`updated_at=now()`);if(set.length){const result=await db.query(`UPDATE users u SET ${set.join(",")} WHERE lower(COALESCE(to_jsonb(u)->>'role','')) LIKE '%customer%' AND (($1<>'' AND lower(COALESCE(to_jsonb(u)->>'email',''))=$1) OR ($2<>'' AND regexp_replace(COALESCE(to_jsonb(u)->>'phone',''),'\\D','','g')=$2))`,[email,phone]);if(result.rowCount)affected.users=Number(result.rowCount)}}
  const profiles=await columns(db,"crm_guest_profiles");if(profiles.length&&(email||phone)){const result=await db.query(`UPDATE crm_guest_profiles p SET contact_key='gdpr:'||id::text,client_name='Anonimizált ügyfél',client_email=NULL,client_phone=NULL,updated_at=now() WHERE ($1<>'' AND lower(COALESCE(client_email,''))=$1) OR ($2<>'' AND regexp_replace(COALESCE(client_phone,''),'\\D','','g')=$2`,[email,phone]);if(result.rowCount)affected.crm_guest_profiles=Number(result.rowCount)}return affected;
}

export function previewHash(value:unknown){return createHash("sha256").update(JSON.stringify(value)).digest("hex")}

export async function activeSubjectHolds(db:Queryable,subjectId:string){
  return(await db.query(`SELECT id,reason,starts_at,expires_at FROM gdpr_legal_holds WHERE scope_type='subject' AND scope_ref=$1 AND status='active' AND (expires_at IS NULL OR expires_at>now()) ORDER BY starts_at`,[`client:${subjectId}`])).rows;
}

export async function anonymizeSubject(db:Queryable,subjectId:string,requestId:string){
  const rootRecord=(await db.query(`SELECT to_jsonb(c) record FROM clients c WHERE id::text=$1 FOR UPDATE`,[subjectId])).rows[0]?.record;if(!rootRecord)throw new Error("A jóváhagyott érintetti rekord már nem található.");
  const protectedFinancial=Number((await db.query(`SELECT count(*)::int count FROM work_orders w WHERE w.client_id::text=$1 AND (COALESCE(w.fully_paid,false) OR lower(COALESCE(w.status,'')) IN ('completed','closed','finalized','paid') OR EXISTS(SELECT 1 FROM finance_invoices i WHERE i.work_order_id=w.id))`,[subjectId]).catch(async()=>({rows:[{count:Number((await db.query(`SELECT count(*)::int count FROM work_orders w WHERE w.client_id::text=$1 AND (COALESCE(w.fully_paid,false) OR lower(COALESCE(w.status,'')) IN ('completed','closed','finalized','paid'))`,[subjectId])).rows[0]?.count||0)}]}))).rows[0]?.count||0);
  const affected:Record<string,number>={...await scrubContactDuplicates(db,rootRecord)},scrubbed:string[]=Object.keys(affected),unlinked:string[]=[],preserved:string[]=[];
  for(const table of Object.keys(SCRUB_RULES).filter(name=>name!=="clients")){
    const count=await scrubTable(db,table,subjectId,requestId);if(count){affected[table]=count;scrubbed.push(table)}
  }
  const linked=(await db.query(`SELECT table_name,column_name,is_nullable FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('client_id','customer_id') AND table_name NOT LIKE 'gdpr_%' ORDER BY table_name,column_name`)).rows;
  for(const row of linked){const table=String(row.table_name),column=String(row.column_name);if(PRESERVE_LINK.has(table)){if(!preserved.includes(table))preserved.push(table);continue}if(String(row.is_nullable)!=="YES"){if(!preserved.includes(table))preserved.push(table);continue}const result=await db.query(`UPDATE ${qid(table)} SET ${qid(column)}=NULL WHERE ${qid(column)}::text=$1`,[subjectId]);if(result.rowCount){unlinked.push(table);affected[table]=(affected[table]||0)+Number(result.rowCount)}}
  const root=await scrubTable(db,"clients",subjectId,requestId);if(!root)throw new Error("A jóváhagyott érintetti rekord már nem található.");affected.clients=root;scrubbed.push("clients");
  return{mode:"anonymization_no_physical_delete",subject_key:`client:${subjectId}`,affected_rows:Object.values(affected).reduce((sum,count)=>sum+count,0),affected,scrubbed_tables:[...new Set(scrubbed)],unlinked_tables:[...new Set(unlinked)],preserved_integrity_links:[...new Set(preserved)],preserved_legal_records:{finalized_financial_records:protectedFinancial}};
}
