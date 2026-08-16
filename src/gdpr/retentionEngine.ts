import { previewHash } from "./subjectActions";

type Queryable={query:(sql:string,params?:any[])=>Promise<any>};
type Adapter={table:string;time:string;where?:string;subjectColumn?:string;anonymize:string};

const adapters:Record<string,Adapter>={
  crm_form_responses:{table:"crm_form_responses",time:"completed_at",subjectColumn:"client_id",anonymize:`response_data='{\"anonymized\":true}'::jsonb`},
  crm_client_notes:{table:"crm_client_notes",time:"created_at",subjectColumn:"client_id",anonymize:`note_text='[megőrzési szabály szerint anonimizált]'`},
  newsletter_deliveries:{table:"newsletter_deliveries",time:"sent_at",where:"sent_at IS NOT NULL",subjectColumn:"client_id",anonymize:`email=NULL,error=NULL,client_id=NULL`},
  booking_communication_queue:{table:"booking_communication_queue",time:"COALESCE(sent_at,failed_at,created_at)",subjectColumn:"client_id",anonymize:`recipient='[anonimizált]',body_text='[anonimizált]',body_html=NULL,error_text=NULL,client_id=NULL,updated_at=now()`},
  app_push_subscriptions:{table:"app_push_subscriptions",time:"COALESCE(last_seen_at,updated_at,created_at)",subjectColumn:"client_id",anonymize:`endpoint='gdpr-retention:'||id::text,subscription='{}'::jsonb,active=false,client_id=NULL,updated_at=now()`},
  gdpr_data_subject_requests:{table:"gdpr_data_subject_requests",time:"COALESCE(completed_at,updated_at)",where:`status IN ('completed','rejected','cancelled')`,anonymize:`subject_name='Anonimizált érintett',subject_contact=NULL,scope=NULL,updated_at=now()`},
};

function adapterFor(policy:any){const adapter=adapters[String(policy.entity_type||"")];if(!adapter)throw Object.assign(new Error("Ehhez az adattípushoz nincs biztonságos, jóváhagyott megőrzési adapter."),{status:422});if(String(policy.action)==="delete")throw Object.assign(new Error("Fizikai törlés nem hajtható végre automatikusan; anonimizálás vagy inaktiválás választható."),{status:422});if(!["anonymize","soft_delete"].includes(String(policy.action)))throw Object.assign(new Error("A felülvizsgálati művelet nem hajtható végre automatikusan."),{status:422});return adapter}
function holdSql(adapter:Adapter){const entity=`h.scope_type='entity' AND h.scope_ref='${adapter.table}:'||x.id::text`;const subject=adapter.subjectColumn?` OR (h.scope_type='subject' AND h.scope_ref='client:'||x.${adapter.subjectColumn}::text)`:"";return`EXISTS(SELECT 1 FROM gdpr_legal_holds h WHERE h.status='active' AND (h.expires_at IS NULL OR h.expires_at>now()) AND ((${entity})${subject}))`}
function baseWhere(adapter:Adapter){return`${adapter.time}<=$2::timestamptz${adapter.where?` AND (${adapter.where})`:""} AND NOT EXISTS(SELECT 1 FROM gdpr_retention_processed p WHERE p.policy_id=$1::uuid AND p.entity_id=x.id::text)`}

export function retentionCapabilities(){return Object.keys(adapters).map(entity_type=>({entity_type,supported_actions:["anonymize","soft_delete"]}))}

export async function retentionPreview(db:Queryable,policy:any,cutoffAt:string){
  const adapter=adapterFor(policy),where=baseWhere(adapter),held=holdSql(adapter);
  const row=(await db.query(`SELECT count(*)::int candidate_count,count(*) FILTER(WHERE ${held})::int legal_hold_count,(COALESCE(array_agg(x.id::text ORDER BY x.id) FILTER(WHERE NOT ${held}),ARRAY[]::text[]))[1:20] sample_ids,md5(COALESCE(string_agg(x.id::text,',' ORDER BY x.id),'')) candidate_digest FROM ${adapter.table} x WHERE ${where}`,[policy.id,cutoffAt])).rows[0];
  const summary={policy_id:String(policy.id),entity_type:String(policy.entity_type),action:String(policy.action),cutoff_at:cutoffAt,candidate_count:Number(row?.candidate_count||0),legal_hold_count:Number(row?.legal_hold_count||0),sample_ids:row?.sample_ids||[],candidate_digest:String(row?.candidate_digest||"")};return{...summary,preview_hash:previewHash(summary)};
}

export async function retentionExecute(db:Queryable,policy:any,run:any,batchSize=500){
  const current=await retentionPreview(db,policy,new Date(run.cutoff_at).toISOString());if(current.preview_hash!==run.preview_hash)throw Object.assign(new Error("A jelölt adatok az előnézet óta megváltoztak. Új előnézet és jóváhagyás szükséges."),{status:409});
  const adapter=adapterFor(policy),where=baseWhere(adapter),held=holdSql(adapter);
  const ids=(await db.query(`SELECT x.id::text id FROM ${adapter.table} x WHERE ${where} AND NOT ${held} ORDER BY x.id LIMIT $3`,[policy.id,run.cutoff_at,Math.max(1,Math.min(1000,Number(batchSize)||500))])).rows.map((row:any)=>String(row.id));
  if(!ids.length)return{processed:0,legal_hold_count:current.legal_hold_count,remaining:Math.max(0,current.candidate_count-current.legal_hold_count),entity_type:policy.entity_type,action:policy.action};
  const update=await db.query(`UPDATE ${adapter.table} SET ${adapter.anonymize} WHERE id::text=ANY($1::text[])`,[ids]);
  for(const id of ids)await db.query(`INSERT INTO gdpr_retention_processed(policy_id,entity_id,run_id) VALUES($1,$2,$3) ON CONFLICT(policy_id,entity_id) DO NOTHING`,[policy.id,id,run.id]);
  return{processed:Number(update.rowCount||0),legal_hold_count:current.legal_hold_count,remaining:Math.max(0,current.candidate_count-current.legal_hold_count-ids.length),entity_type:policy.entity_type,action:policy.action};
}
