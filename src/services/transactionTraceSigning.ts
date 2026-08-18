import crypto from "crypto";
import cron from "node-cron";
import db from "../db";
import {ensureTransactionTraceabilitySchema} from "./transactionTraceability";

const TZ="Europe/Budapest";
let ready:Promise<void>|null=null;
let started=false;
const secret=()=>String(process.env.TRANSACTION_TRACE_HMAC_KEY||"").trim();
const keyId=()=>String(process.env.TRANSACTION_TRACE_HMAC_KEY_ID||"render-hmac-v1").trim()||"render-hmac-v1";

export function ensureTransactionTraceSigningSchema(){
 if(!ready)ready=(async()=>{await ensureTransactionTraceabilitySchema();await db.query(`
  CREATE TABLE IF NOT EXISTS business_transaction_proof_signatures(
    id bigserial PRIMARY KEY,
    trace_id uuid NOT NULL REFERENCES business_transaction_traces(trace_id) ON DELETE RESTRICT,
    trace_sequence bigint NOT NULL,
    trace_hash text NOT NULL,
    algorithm text NOT NULL DEFAULT 'HMAC-SHA256',
    key_id text NOT NULL,
    signature text NOT NULL,
    signed_by text NOT NULL DEFAULT 'system',
    signed_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(trace_id,trace_sequence,trace_hash,key_id)
  );
  CREATE INDEX IF NOT EXISTS business_transaction_proof_signatures_trace_idx ON business_transaction_proof_signatures(trace_id,signed_at DESC);
  CREATE OR REPLACE FUNCTION kleo_transaction_signature_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN RAISE EXCEPTION 'business_transaction_proof_signatures is append-only'; END $$;
  DROP TRIGGER IF EXISTS trg_business_transaction_signature_immutable ON business_transaction_proof_signatures;
  CREATE TRIGGER trg_business_transaction_signature_immutable BEFORE UPDATE OR DELETE ON business_transaction_proof_signatures
  FOR EACH ROW EXECUTE FUNCTION kleo_transaction_signature_immutable();
 `)})().catch(error=>{ready=null;throw error});return ready
}

function payload(trace:any){return `KLEO-TRACE-PROOF-V1|${trace.trace_id}|${Number(trace.last_sequence||0)}|${String(trace.last_hash||"")}`}
function hmac(value:string,key:string){return crypto.createHmac("sha256",key).update(value,"utf8").digest("hex")}
function safeSignatureEqual(expected:string,actual:unknown){const candidate=String(actual||"");if(!/^[a-f0-9]{64}$/i.test(expected)||!/^[a-f0-9]{64}$/i.test(candidate))return false;const a=Buffer.from(expected,"hex"),b=Buffer.from(candidate,"hex");return a.length===b.length&&crypto.timingSafeEqual(a,b)}

export async function signTraceProof(traceId:string,signedBy="system"){
 await ensureTransactionTraceSigningSchema();const key=secret();
 const trace=(await db.query(`SELECT trace_id::text,root_type,root_id,last_sequence,last_hash,integrity_status,lifecycle_status FROM business_transaction_traces WHERE trace_id=$1::uuid`,[traceId])).rows[0];
 if(!trace)throw Object.assign(new Error("A trace nem található."),{status:404});
 if(!trace.last_hash||Number(trace.last_sequence||0)<=0)return{configured:Boolean(key),status:"unavailable",message:"A trace még nem tartalmaz aláírható eseményt.",key_id:keyId()};
 if(!key)return{configured:false,status:"unsigned",message:"TRANSACTION_TRACE_HMAC_KEY nincs konfigurálva; a hash-lánc ellenőrizhető, de külső kulcsos aláírás nincs.",key_id:keyId(),trace_sequence:Number(trace.last_sequence),trace_hash:String(trace.last_hash)};
 const signature=hmac(payload(trace),key),kid=keyId();
 await db.query(`INSERT INTO business_transaction_proof_signatures(trace_id,trace_sequence,trace_hash,key_id,signature,signed_by)
   VALUES($1::uuid,$2,$3,$4,$5,$6) ON CONFLICT(trace_id,trace_sequence,trace_hash,key_id) DO NOTHING`,[trace.trace_id,Number(trace.last_sequence),String(trace.last_hash),kid,signature,signedBy]);
 return verifyTraceProofSignature(traceId);
}

export async function verifyTraceProofSignature(traceId:string){
 await ensureTransactionTraceSigningSchema();const key=secret(),kid=keyId();
 const trace=(await db.query(`SELECT trace_id::text,root_type,root_id,last_sequence,last_hash,integrity_status,lifecycle_status FROM business_transaction_traces WHERE trace_id=$1::uuid`,[traceId])).rows[0];
 if(!trace)throw Object.assign(new Error("A trace nem található."),{status:404});
 const row=(await db.query(`SELECT trace_sequence,trace_hash,algorithm,key_id,signature,signed_by,signed_at FROM business_transaction_proof_signatures WHERE trace_id=$1::uuid ORDER BY signed_at DESC,id DESC LIMIT 1`,[traceId])).rows[0];
 if(!row)return{configured:Boolean(key),status:key?"missing":"unsigned",valid:false,current:false,message:key?"Ehhez a trace-hez még nincs HMAC proof checkpoint.":"TRANSACTION_TRACE_HMAC_KEY nincs konfigurálva.",key_id:kid};
 const current=Number(row.trace_sequence)===Number(trace.last_sequence)&&String(row.trace_hash)===String(trace.last_hash||"");
 if(!key)return{configured:false,status:"unsigned",valid:false,current,message:"A tárolt HMAC aláírás kulcs nélkül nem ellenőrizhető.",...row};
 const expected=hmac(payload({...trace,last_sequence:row.trace_sequence,last_hash:row.trace_hash}),key),valid=safeSignatureEqual(expected,row.signature);
 return{configured:true,status:valid&&current?"verified":valid?"stale":"broken",valid,current,message:valid&&current?"A külső kulccsal aláírt proof checkpoint érvényes és a trace aktuális állapotára vonatkozik.":valid?"Az aláírás érvényes, de a trace azóta új eseménnyel bővült.":"A HMAC proof checkpoint érvénytelen; a bizonyítási lánc vizsgálata szükséges.",...row};
}

export async function signRecentTraceProofs(limit=500){
 await ensureTransactionTraceSigningSchema();if(!secret())return{configured:false,signed:0,failed:0,message:"TRANSACTION_TRACE_HMAC_KEY nincs konfigurálva."};
 const traces=(await db.query(`SELECT trace_id::text FROM business_transaction_traces WHERE last_sequence>0 ORDER BY last_seen_at DESC LIMIT $1`,[Math.max(1,Math.min(2000,Number(limit||500)))])).rows;let signed=0,failed=0;
 for(const row of traces){try{await signTraceProof(String(row.trace_id),'scheduled-signing');signed++}catch{failed++}}
 return{configured:true,signed,failed,generated_at:new Date().toISOString()};
}

export function startTraceProofSigningMaintenance(){if(started||process.env.TRANSACTION_TRACE_DISABLED==='1'||process.env.NODE_ENV==='test')return;started=true;cron.schedule('*/15 * * * *',()=>{void signRecentTraceProofs(1000).catch(error=>console.error('[transaction-trace] proof signing failed',error))},{timezone:TZ});const timer=setTimeout(()=>{void signRecentTraceProofs(500).catch(error=>console.error('[transaction-trace] initial proof signing failed',error))},105_000);timer.unref?.();console.log('[transaction-trace] HMAC proof signing scheduled every 15 minutes')}
