import { Router, Response } from "express";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import pool from "../db";
import { AuthRequest } from "../middleware/auth";
import { parseRoleKeys } from "../security/roles";

const router = Router();
export const fitnessLockerBridgeRouter = Router();
const SCOPE = "GYONGYOS_FITNESS";
const LOCKER_COUNT = 20;
const MAX_CHANNEL = 24;
let schemaPromise: Promise<void> | null = null;

const sha256 = (v: unknown) => createHash("sha256").update(String(v ?? "").trim()).digest("hex");
const cleanCard = (v: unknown) => String(v ?? "").trim().replace(/\s+/g, "");
const roles = (req: AuthRequest) => parseRoleKeys(req.user?.role);
const isAdmin = (req: AuthRequest) => roles(req).includes("admin");
const isReception = (req: AuthRequest) => roles(req).includes("receptionist");
const actor = (req: AuthRequest) => String(req.user?.email || req.user?.id || "");
const lockerNo = (v: unknown) => { const n = Number.parseInt(String(v ?? ""), 10); return Number.isFinite(n) && n >= 1 && n <= LOCKER_COUNT ? n : null; };
const channelNo = (v: unknown) => { const n = Number.parseInt(String(v ?? ""), 10); return Number.isFinite(n) && n >= 1 && n <= MAX_CHANNEL ? n : null; };

async function ensureSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vir_fitness_locker_settings(
        scope_key text PRIMARY KEY, location_id uuid NOT NULL, enabled boolean NOT NULL DEFAULT true,
        controller_mode text NOT NULL DEFAULT 'RS485_BRIDGE', controller_name text NOT NULL DEFAULT 'GYONGYOS-LOCKER-01',
        bridge_token_hash text, auto_assign boolean NOT NULL DEFAULT true, last_heartbeat_at timestamptz,
        last_source text, updated_by text, updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS vir_fitness_lockers(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL,
        locker_no integer NOT NULL CHECK(locker_no BETWEEN 1 AND 20),
        controller_channel integer NOT NULL CHECK(controller_channel BETWEEN 1 AND 24),
        status text NOT NULL DEFAULT 'AVAILABLE', door_state text NOT NULL DEFAULT 'UNKNOWN', enabled boolean NOT NULL DEFAULT true,
        notes text, last_seen_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(location_id,locker_no), UNIQUE(location_id,controller_channel)
      );
      CREATE TABLE IF NOT EXISTS vir_fitness_locker_assignments(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL, locker_id uuid NOT NULL REFERENCES vir_fitness_lockers(id),
        membership_id uuid, member_name text, card_uid_hash text NOT NULL, card_last4 text, status text NOT NULL DEFAULT 'ACTIVE',
        assigned_at timestamptz NOT NULL DEFAULT now(), last_open_at timestamptz, released_at timestamptz, released_by text
      );
      CREATE UNIQUE INDEX IF NOT EXISTS vir_fitness_locker_active_locker_uq ON vir_fitness_locker_assignments(locker_id) WHERE status='ACTIVE';
      CREATE UNIQUE INDEX IF NOT EXISTS vir_fitness_locker_active_card_uq ON vir_fitness_locker_assignments(location_id,card_uid_hash) WHERE status='ACTIVE';
      CREATE TABLE IF NOT EXISTS vir_fitness_locker_commands(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL, locker_id uuid NOT NULL REFERENCES vir_fitness_lockers(id),
        locker_no integer NOT NULL, controller_channel integer NOT NULL, command text NOT NULL DEFAULT 'OPEN', state text NOT NULL DEFAULT 'QUEUED',
        source text NOT NULL DEFAULT 'VIR', correlation_id text NOT NULL UNIQUE, created_by text, created_at timestamptz NOT NULL DEFAULT now(),
        delivered_at timestamptz, acked_at timestamptz, failed_at timestamptz, error_message text
      );
      CREATE INDEX IF NOT EXISTS vir_fitness_locker_command_queue_idx ON vir_fitness_locker_commands(location_id,state,created_at);
      CREATE TABLE IF NOT EXISTS vir_fitness_locker_events(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL, locker_id uuid REFERENCES vir_fitness_lockers(id),
        assignment_id uuid REFERENCES vir_fitness_locker_assignments(id), locker_no integer, event_type text NOT NULL, source text NOT NULL,
        actor text, correlation_id text, metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS vir_fitness_locker_events_idx ON vir_fitness_locker_events(location_id,created_at DESC);
    `);
    const base = (await pool.query(`SELECT location_id FROM vir_fitness_settings WHERE scope_key=$1`, [SCOPE])).rows[0];
    if (!base?.location_id) throw new Error("FITNESS_LOCATION_NOT_CONFIGURED");
    await pool.query(`INSERT INTO vir_fitness_locker_settings(scope_key,location_id) VALUES($1,$2::uuid)
      ON CONFLICT(scope_key) DO UPDATE SET location_id=EXCLUDED.location_id`, [SCOPE, base.location_id]);
    for (let i = 1; i <= LOCKER_COUNT; i += 1) {
      await pool.query(`INSERT INTO vir_fitness_lockers(location_id,locker_no,controller_channel) VALUES($1::uuid,$2,$2)
        ON CONFLICT(location_id,locker_no) DO NOTHING`, [base.location_id, i]);
    }
  })().catch((e) => { schemaPromise = null; throw e; });
  return schemaPromise;
}

async function settings() { await ensureSchema(); return (await pool.query(`SELECT * FROM vir_fitness_locker_settings WHERE scope_key=$1`, [SCOPE])).rows[0] || null; }
async function requireLockerAccess(req: AuthRequest, res: Response) {
  const s = await settings(); const own = String(req.user?.location_id || "");
  const allowed = isAdmin(req) || (isReception(req) && own && own === String(s?.location_id || ""));
  if (!allowed) { res.status(403).json({ ok:false, code:"FITNESS_GYONGYOS_ONLY", message:"A szekrényrendszerhez csak az adminisztrátor és a gyöngyösi recepció férhet hozzá." }); return null; }
  return s;
}
async function requireAdmin(req: AuthRequest, res: Response) { const s=await requireLockerAccess(req,res); if(!s)return null; if(!isAdmin(req)){res.status(403).json({ok:false,message:"Csak adminisztrátor módosíthatja a szekrényvezérlő beállításait."});return null;} return s; }
function publicSettings(s:any){ if(!s)return null; const {bridge_token_hash,...safe}=s; return {...safe,bridge_token_configured:Boolean(bridge_token_hash)}; }
function bridgeToken(req:any) { return String(req.headers?.["x-fitness-locker-token"] || req.headers?.authorization?.replace(/^Bearer\s+/i,"") || "").trim(); }
async function requireBridge(req:any,res:Response){ const s=await settings(),token=bridgeToken(req),expected=String(s?.bridge_token_hash||""); if(!token||!expected){res.status(401).json({ok:false,code:"LOCKER_BRIDGE_AUTH_REQUIRED"});return null;} const actual=sha256(token),a=Buffer.from(actual),b=Buffer.from(expected); if(a.length!==b.length||!timingSafeEqual(a,b)){res.status(401).json({ok:false,code:"LOCKER_BRIDGE_AUTH_FAILED"});return null;} return s; }

async function writeEvent(locationId:string, data:any){ await pool.query(`INSERT INTO vir_fitness_locker_events(location_id,locker_id,assignment_id,locker_no,event_type,source,actor,correlation_id,metadata)
  VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9::jsonb)`,[locationId,data.locker_id||null,data.assignment_id||null,data.locker_no||null,data.event_type,data.source,data.actor||null,data.correlation_id||null,JSON.stringify(data.metadata||{})]); }
async function queueOpen(locationId:string, locker:any, source:string, createdBy:string, assignmentId?:string|null){ const correlationId=randomUUID(); const row=(await pool.query(`INSERT INTO vir_fitness_locker_commands(location_id,locker_id,locker_no,controller_channel,command,state,source,correlation_id,created_by)
  VALUES($1::uuid,$2::uuid,$3,$4,'OPEN','QUEUED',$5,$6,$7) RETURNING *`,[locationId,locker.id,locker.locker_no,locker.controller_channel,source,correlationId,createdBy])).rows[0]; if(assignmentId)await pool.query(`UPDATE vir_fitness_locker_assignments SET last_open_at=now() WHERE id=$1::uuid`,[assignmentId]); await writeEvent(locationId,{locker_id:locker.id,assignment_id:assignmentId||null,locker_no:locker.locker_no,event_type:"OPEN_COMMAND",source,actor:createdBy,correlation_id:correlationId,metadata:{controller_channel:locker.controller_channel}}); return row; }

router.get("/",async(req:AuthRequest,res)=>{try{const s=await requireLockerAccess(req,res);if(!s)return;const {rows}=await pool.query(`SELECT l.*,a.id assignment_id,a.membership_id,a.member_name,a.card_last4,a.assigned_at,a.last_open_at FROM vir_fitness_lockers l LEFT JOIN vir_fitness_locker_assignments a ON a.locker_id=l.id AND a.status='ACTIVE' WHERE l.location_id=$1 ORDER BY l.locker_no`,[s.location_id]);res.json({ok:true,lockers:rows,settings:publicSettings(s),summary:{total:20,available:rows.filter((x:any)=>x.status==='AVAILABLE'&&x.enabled).length,occupied:rows.filter((x:any)=>x.status==='OCCUPIED').length,open:rows.filter((x:any)=>x.door_state==='OPEN').length,blocked:rows.filter((x:any)=>!x.enabled||['BLOCKED','MAINTENANCE'].includes(x.status)).length}});}catch(e:any){res.status(500).json({ok:false,message:e?.message});}});
router.get("/events",async(req:AuthRequest,res)=>{try{const s=await requireLockerAccess(req,res);if(!s)return;const limit=Math.max(1,Math.min(300,Number(req.query.limit)||100));res.json((await pool.query(`SELECT * FROM vir_fitness_locker_events WHERE location_id=$1 ORDER BY created_at DESC LIMIT $2`,[s.location_id,limit])).rows);}catch(e:any){res.status(500).json({message:e?.message});}});

router.post("/scan",async(req:AuthRequest,res)=>{const card=cleanCard(req.body?.card_uid);if(!card)return res.status(400).json({ok:false,message:"Kártyaazonosító szükséges."});let client:any;try{const s=await requireLockerAccess(req,res);if(!s)return;const hash=sha256(card);const membership=(await pool.query(`SELECT m.*,p.name plan_name FROM vir_fitness_memberships m LEFT JOIN vir_fitness_membership_plans p ON p.id=m.plan_id WHERE m.location_id=$1 AND m.card_uid_hash=$2 ORDER BY m.valid_until DESC LIMIT 1`,[s.location_id,hash])).rows[0];const today=new Date().toISOString().slice(0,10);if(!membership||membership.status!=='ACTIVE'||String(membership.valid_from).slice(0,10)>today||String(membership.valid_until).slice(0,10)<today){await writeEvent(s.location_id,{event_type:"SCAN_DENIED",source:"KIOSK",actor:actor(req),metadata:{reason:"NO_ACTIVE_MEMBERSHIP",card_last4:card.slice(-4)}});return res.status(403).json({ok:false,decision:"DENIED",reason:"Nincs érvényes Fitness bérlet ehhez a kártyához."});}
client=await pool.connect();await client.query('BEGIN');let assignment=(await client.query(`SELECT a.*,l.locker_no,l.controller_channel,l.status locker_status,l.enabled,l.id locker_id FROM vir_fitness_locker_assignments a JOIN vir_fitness_lockers l ON l.id=a.locker_id WHERE a.location_id=$1 AND a.card_uid_hash=$2 AND a.status='ACTIVE' FOR UPDATE`,[s.location_id,hash])).rows[0];if(!assignment){const free=(await client.query(`SELECT l.* FROM vir_fitness_lockers l WHERE l.location_id=$1 AND l.enabled=true AND l.status='AVAILABLE' AND l.door_state<>'OPEN' AND NOT EXISTS(SELECT 1 FROM vir_fitness_locker_assignments a WHERE a.locker_id=l.id AND a.status='ACTIVE') ORDER BY l.locker_no FOR UPDATE SKIP LOCKED LIMIT 1`,[s.location_id])).rows[0];if(!free){await client.query('ROLLBACK');client.release();client=null;await writeEvent(s.location_id,{event_type:"SCAN_DENIED",source:"KIOSK",actor:actor(req),metadata:{reason:"NO_FREE_LOCKER"}});return res.status(409).json({ok:false,decision:"DENIED",reason:"Jelenleg nincs szabad öltözőszekrény."});}assignment=(await client.query(`INSERT INTO vir_fitness_locker_assignments(location_id,locker_id,membership_id,member_name,card_uid_hash,card_last4) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6) RETURNING *, $7::int locker_no,$8::int controller_channel,$2::uuid locker_id`,[s.location_id,free.id,membership.id,membership.member_name,hash,card.slice(-4),free.locker_no,free.controller_channel])).rows[0];await client.query(`UPDATE vir_fitness_lockers SET status='OCCUPIED',updated_at=now() WHERE id=$1`,[free.id]);}
const corr=randomUUID();await client.query(`INSERT INTO vir_fitness_locker_commands(location_id,locker_id,locker_no,controller_channel,command,state,source,correlation_id,created_by) VALUES($1::uuid,$2::uuid,$3,$4,'OPEN','QUEUED','KIOSK',$5,$6)`,[s.location_id,assignment.locker_id,assignment.locker_no,assignment.controller_channel,corr,actor(req)]);await client.query(`UPDATE vir_fitness_locker_assignments SET last_open_at=now() WHERE id=$1`,[assignment.id]);await client.query(`INSERT INTO vir_fitness_locker_events(location_id,locker_id,assignment_id,locker_no,event_type,source,actor,correlation_id,metadata) VALUES($1::uuid,$2::uuid,$3::uuid,$4,'CARD_OPEN','KIOSK',$5,$6,$7::jsonb)`,[s.location_id,assignment.locker_id,assignment.id,assignment.locker_no,actor(req),corr,JSON.stringify({member_name:membership.member_name})]);await client.query('COMMIT');client.release();client=null;res.json({ok:true,decision:"GRANTED",locker_no:assignment.locker_no,member_name:membership.member_name,correlation_id:corr,message:`A(z) ${assignment.locker_no}. rekesz nyílik.`});}catch(e:any){if(client){await client.query('ROLLBACK').catch(()=>undefined);client.release();}res.status(500).json({ok:false,message:e?.message});}});

router.post("/:lockerNo/open",async(req:AuthRequest,res)=>{try{const s=await requireLockerAccess(req,res);if(!s)return;const n=lockerNo(req.params.lockerNo);if(!n)return res.status(400).json({message:"Érvénytelen rekeszszám."});const l=(await pool.query(`SELECT l.*,a.id assignment_id FROM vir_fitness_lockers l LEFT JOIN vir_fitness_locker_assignments a ON a.locker_id=l.id AND a.status='ACTIVE' WHERE l.location_id=$1 AND l.locker_no=$2`,[s.location_id,n])).rows[0];if(!l||!l.enabled)return res.status(409).json({message:"A rekesz nem nyitható."});const cmd=await queueOpen(s.location_id,l,isAdmin(req)?"ADMIN":"RECEPTION",actor(req),l.assignment_id);res.json({ok:true,command:cmd});}catch(e:any){res.status(500).json({message:e?.message});}});
router.post("/:lockerNo/release",async(req:AuthRequest,res)=>{try{const s=await requireLockerAccess(req,res);if(!s)return;const n=lockerNo(req.params.lockerNo);if(!n)return res.status(400).json({message:"Érvénytelen rekeszszám."});const l=(await pool.query(`SELECT * FROM vir_fitness_lockers WHERE location_id=$1 AND locker_no=$2`,[s.location_id,n])).rows[0];if(!l)return res.status(404).json({message:"Rekesz nem található."});const a=(await pool.query(`UPDATE vir_fitness_locker_assignments SET status='RELEASED',released_at=now(),released_by=$2 WHERE locker_id=$1 AND status='ACTIVE' RETURNING *`,[l.id,actor(req)])).rows[0];await pool.query(`UPDATE vir_fitness_lockers SET status=CASE WHEN door_state='OPEN' THEN 'OPEN' ELSE 'AVAILABLE' END,updated_at=now() WHERE id=$1`,[l.id]);await writeEvent(s.location_id,{locker_id:l.id,assignment_id:a?.id,locker_no:n,event_type:"RELEASED",source:isAdmin(req)?"ADMIN":"RECEPTION",actor:actor(req)});res.json({ok:true});}catch(e:any){res.status(500).json({message:e?.message});}});
router.patch("/:lockerNo",async(req:AuthRequest,res)=>{try{const s=await requireAdmin(req,res);if(!s)return;const n=lockerNo(req.params.lockerNo),channel=channelNo(req.body?.controller_channel);if(!n||!channel)return res.status(400).json({message:"Rekesz- vagy csatornaszám hibás."});const enabled=req.body?.enabled!==false,requested=String(req.body?.status||'AVAILABLE').toUpperCase(),status=['AVAILABLE','BLOCKED','MAINTENANCE'].includes(requested)?requested:'AVAILABLE';const row=(await pool.query(`UPDATE vir_fitness_lockers SET controller_channel=$3,enabled=$4,status=CASE WHEN EXISTS(SELECT 1 FROM vir_fitness_locker_assignments a WHERE a.locker_id=vir_fitness_lockers.id AND a.status='ACTIVE') THEN status ELSE $5 END,notes=$6,updated_at=now() WHERE location_id=$1 AND locker_no=$2 RETURNING *`,[s.location_id,n,channel,enabled,status,String(req.body?.notes||'')||null])).rows[0];res.json({ok:true,locker:row});}catch(e:any){res.status(500).json({message:e?.code==='23505'?"Ez a vezérlőcsatorna már másik rekeszhez tartozik.":e?.message});}});
router.get("/controller/status",async(req:AuthRequest,res)=>{try{const s=await requireLockerAccess(req,res);if(s)res.json({ok:true,settings:publicSettings(s),online:Boolean(s.last_heartbeat_at&&Date.now()-new Date(s.last_heartbeat_at).getTime()<90000)});}catch(e:any){res.status(500).json({message:e?.message});}});
router.post("/controller/token",async(req:AuthRequest,res)=>{try{const s=await requireAdmin(req,res);if(!s)return;const token=`kleo-locker-${randomBytes(32).toString('base64url')}`;await pool.query(`UPDATE vir_fitness_locker_settings SET bridge_token_hash=$2,enabled=true,updated_by=$3,updated_at=now() WHERE scope_key=$1`,[SCOPE,sha256(token),actor(req)]);res.json({ok:true,token,warning:"A locker bridge token csak most látható; a helyi bridge-ben kell biztonságosan tárolni."});}catch(e:any){res.status(500).json({message:e?.message});}});

fitnessLockerBridgeRouter.post("/heartbeat",async(req:any,res)=>{try{const s=await requireBridge(req,res);if(!s)return;await pool.query(`UPDATE vir_fitness_locker_settings SET last_heartbeat_at=now(),last_source=$2,updated_at=now() WHERE scope_key=$1`,[SCOPE,String(req.body?.source||req.ip||'LOCKER_BRIDGE').slice(0,180)]);res.json({ok:true,server_time:new Date().toISOString(),locker_count:LOCKER_COUNT});}catch(e:any){res.status(500).json({message:e?.message});}});
fitnessLockerBridgeRouter.get("/commands",async(req:any,res)=>{let c:any;try{const s=await requireBridge(req,res);if(!s)return;const limit=Math.max(1,Math.min(24,Number(req.query.limit)||10));c=await pool.connect();await c.query('BEGIN');const rows=(await c.query(`SELECT * FROM vir_fitness_locker_commands WHERE location_id=$1 AND state='QUEUED' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $2`,[s.location_id,limit])).rows;if(rows.length)await c.query(`UPDATE vir_fitness_locker_commands SET state='DELIVERED',delivered_at=now() WHERE id=ANY($1::uuid[])`,[rows.map((x:any)=>x.id)]);await c.query(`UPDATE vir_fitness_locker_settings SET last_heartbeat_at=now(),last_source='COMMAND_POLL',updated_at=now() WHERE scope_key=$1`,[SCOPE]);await c.query('COMMIT');c.release();c=null;res.json({ok:true,commands:rows.map((x:any)=>({id:x.id,command:x.command,locker_no:x.locker_no,channel:x.controller_channel,correlation_id:x.correlation_id}))});}catch(e:any){if(c){await c.query('ROLLBACK').catch(()=>undefined);c.release();}res.status(500).json({message:e?.message});}});
fitnessLockerBridgeRouter.post("/events",async(req:any,res)=>{try{const s=await requireBridge(req,res);if(!s)return;const list=Array.isArray(req.body?.events)?req.body.events:[req.body],accepted:any[]=[];for(const ev of list.slice(0,100)){const n=lockerNo(ev?.locker_no),door=String(ev?.door_state||'').toUpperCase();if(!n||!['OPEN','CLOSED','UNKNOWN'].includes(door))continue;const l=(await pool.query(`SELECT * FROM vir_fitness_lockers WHERE location_id=$1 AND locker_no=$2`,[s.location_id,n])).rows[0];if(!l)continue;const active=(await pool.query(`SELECT id FROM vir_fitness_locker_assignments WHERE locker_id=$1 AND status='ACTIVE' LIMIT 1`,[l.id])).rows[0],newStatus=door==='OPEN'?'OPEN':active?'OCCUPIED':l.enabled?'AVAILABLE':l.status;await pool.query(`UPDATE vir_fitness_lockers SET door_state=$2,status=$3,last_seen_at=now(),updated_at=now() WHERE id=$1`,[l.id,door,newStatus]);if(ev?.command_id)await pool.query(`UPDATE vir_fitness_locker_commands SET state=CASE WHEN $2::boolean THEN 'ACKED' ELSE 'FAILED' END,acked_at=CASE WHEN $2::boolean THEN now() ELSE acked_at END,failed_at=CASE WHEN $2::boolean THEN failed_at ELSE now() END,error_message=$3 WHERE id=$1::uuid`,[String(ev.command_id),ev.success!==false,ev.error?String(ev.error):null]).catch(()=>undefined);await writeEvent(s.location_id,{locker_id:l.id,assignment_id:active?.id,locker_no:n,event_type:door==='OPEN'?"DOOR_OPEN":"DOOR_CLOSED",source:"LOCKER_BRIDGE",correlation_id:ev?.correlation_id?String(ev.correlation_id):null,metadata:{success:ev?.success!==false,error:ev?.error||null}});accepted.push(n);}await pool.query(`UPDATE vir_fitness_locker_settings SET last_heartbeat_at=now(),last_source='DOOR_EVENT',updated_at=now() WHERE scope_key=$1`,[SCOPE]);res.json({ok:true,accepted});}catch(e:any){res.status(500).json({message:e?.message});}});

export default router;
