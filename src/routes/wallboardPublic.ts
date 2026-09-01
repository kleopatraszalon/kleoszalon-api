import { Router } from "express";
import pool from "../db";
import { requireAdmin } from "../middleware/requireRoles";
import type { AuthRequest } from "../middleware/auth";
import { getRuntimeSettingsSnapshot, saveRuntimeSettings } from "../services/virRuntimeSettings";
import { applyGitHubReleaseEnvironment, applyRenderHighAvailability, getRenderInfrastructureStatus } from "../services/virInfrastructureControl";
import { getComplaintMailboxStatus, restartComplaintMailboxWorker } from "../services/complaintMailbox";

const router = Router();

function escXml(value: unknown): string {
  return String(value ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;").replace(/'/g,"&apos;");
}
function escHtml(value: unknown): string {
  return String(value ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;").replace(/'/g,"&#39;");
}
function stripHtml(value: unknown): string {
  return String(value ?? "").replace(/<br\s*\/?\s*>/gi,"\n").replace(/<\/p>/gi,"\n").replace(/<[^>]+>/g," ").replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/[ \t]+/g," ").trim();
}
async function currentAction() {
  const r = await pool.query(`
    SELECT id, name, headline, description_html, image_url, cta_label, cta_url, discount_text,
           valid_from, valid_until, updated_at
    FROM daily_action_campaigns
    WHERE status='published' AND valid_from<=now() AND valid_until>=now()
    ORDER BY updated_at DESC, valid_until ASC
    LIMIT 1
  `);
  const row = r.rows[0];
  if (!row) return null;
  return { ...row, description_text: stripHtml(row.description_html) };
}

let queueSchemaPromise: Promise<void> | null = null;
async function ensureKioskQueueSchema() {
  if (queueSchemaPromise) return queueSchemaPromise;
  queueSchemaPromise = (async()=>{
    await pool.query(`
      CREATE TABLE IF NOT EXISTS kiosk_daily_queue_sequences(
        location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        queue_date date NOT NULL,
        last_value integer NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(location_id,queue_date)
      );
      ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS kiosk_queue_no integer;
      ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS kiosk_queue_date date;
      ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS kiosk_queue_code text;
      CREATE UNIQUE INDEX IF NOT EXISTS work_orders_kiosk_queue_uq
        ON work_orders(location_id,kiosk_queue_date,kiosk_queue_no)
        WHERE kiosk_queue_no IS NOT NULL;
      CREATE INDEX IF NOT EXISTS work_orders_kiosk_queue_active_idx
        ON work_orders(location_id,kiosk_queue_date,status,kiosk_queue_no)
        WHERE kiosk_queue_no IS NOT NULL;

      CREATE OR REPLACE FUNCTION next_kiosk_daily_queue(p_location uuid,p_day date)
      RETURNS integer LANGUAGE plpgsql AS $$
      DECLARE n integer;
      BEGIN
        INSERT INTO kiosk_daily_queue_sequences(location_id,queue_date,last_value,updated_at)
        VALUES(p_location,p_day,1,now())
        ON CONFLICT(location_id,queue_date) DO UPDATE
          SET last_value=kiosk_daily_queue_sequences.last_value+1,updated_at=now()
        RETURNING last_value INTO n;
        RETURN n;
      END $$;

      CREATE OR REPLACE FUNCTION assign_kiosk_daily_queue()
      RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE d date; n integer;
      BEGIN
        IF NEW.kiosk_queue_no IS NULL
           AND NEW.location_id IS NOT NULL
           AND COALESCE(NEW.source_snapshot->>'source','')='kiosk' THEN
          d := timezone('Europe/Budapest',COALESCE(NEW.source_created_at,NEW.created_at,now()))::date;
          n := next_kiosk_daily_queue(NEW.location_id,d);
          NEW.kiosk_queue_date := d;
          NEW.kiosk_queue_no := n;
          NEW.kiosk_queue_code := 'KIOSK'||CASE WHEN n<1000 THEN lpad(n::text,3,'0') ELSE n::text END;
        END IF;
        RETURN NEW;
      END $$;

      DROP TRIGGER IF EXISTS trg_assign_kiosk_daily_queue ON work_orders;
      CREATE TRIGGER trg_assign_kiosk_daily_queue
        BEFORE INSERT ON work_orders
        FOR EACH ROW EXECUTE FUNCTION assign_kiosk_daily_queue();
    `);

    await pool.query(`
      DO $$
      DECLARE r record; n integer; d date:=timezone('Europe/Budapest',now())::date;
      BEGIN
        FOR r IN
          SELECT id,location_id
          FROM work_orders
          WHERE kiosk_queue_no IS NULL
            AND location_id IS NOT NULL
            AND COALESCE(source_snapshot->>'source','')='kiosk'
            AND timezone('Europe/Budapest',COALESCE(source_created_at,created_at,now()))::date=d
            AND status IN ('waiting','arrived','in_progress')
          ORDER BY COALESCE(source_created_at,created_at),id
        LOOP
          n:=next_kiosk_daily_queue(r.location_id,d);
          UPDATE work_orders
             SET kiosk_queue_date=d,kiosk_queue_no=n,
                 kiosk_queue_code='KIOSK'||CASE WHEN n<1000 THEN lpad(n::text,3,'0') ELSE n::text END
           WHERE id=r.id;
        END LOOP;
      END $$;
    `);
  })().catch(e=>{ queueSchemaPromise=null; throw e; });
  return queueSchemaPromise;
}

async function resolveQueueLocation(explicit: unknown) {
  const id=String(explicit||"").trim();
  if(id){
    const r=await pool.query(`SELECT id::text id,name FROM locations WHERE id=$1::uuid AND COALESCE(is_active,true)=true`,[id]);
    return r.rows[0]||null;
  }
  const r=await pool.query(`SELECT id::text id,name FROM locations WHERE COALESCE(is_active,true)=true ORDER BY CASE WHEN lower(name) LIKE '%gyöngy%' OR lower(name) LIKE '%gyongy%' THEN 0 ELSE 1 END,name LIMIT 1`);
  return r.rows[0]||null;
}

async function queueRows(locationId: string) {
  await ensureKioskQueueSchema();
  const {rows}=await pool.query(`
    SELECT w.id::text work_order_id,w.work_order_number,w.kiosk_queue_no,w.kiosk_queue_code,w.status,
           w.employee_id::text employee_id,
           COALESCE(NULLIF(e.full_name,''),NULLIF(concat_ws(' ',e.last_name,e.first_name),''),'Szakember kijelölése folyamatban') specialist_name,
           COALESCE(e.photo_url,'') specialist_photo_url
    FROM work_orders w
    LEFT JOIN employees e ON e.id=w.employee_id
    WHERE w.location_id=$1::uuid
      AND w.kiosk_queue_date=timezone('Europe/Budapest',now())::date
      AND w.kiosk_queue_no IS NOT NULL
      AND w.status IN ('waiting','arrived','in_progress')
    ORDER BY w.kiosk_queue_no,w.created_at
  `,[locationId]);
  return rows.map((r:any)=>({...r,column:r.status==='waiting'?'waiting':'ready'}));
}

router.get("/wallboard/daily-action.json", async (_req,res,next)=>{
  try {
    const action=await currentAction();
    res.setHeader("Cache-Control","public, max-age=30, stale-while-revalidate=120");
    res.json({ version:"1.0", generated_at:new Date().toISOString(), action });
  } catch(e){ next(e); }
});

router.get("/wallboard/daily-action.xml", async (_req,res,next)=>{
  try {
    const a=await currentAction();
    res.setHeader("Content-Type","application/xml; charset=utf-8");
    res.setHeader("Cache-Control","public, max-age=30, stale-while-revalidate=120");
    if(!a)return res.send(`<?xml version="1.0" encoding="UTF-8"?><wallboard version="1.0"><generated_at>${escXml(new Date().toISOString())}</generated_at><daily_action /></wallboard>`);
    res.send(`<?xml version="1.0" encoding="UTF-8"?><wallboard version="1.0"><generated_at>${escXml(new Date().toISOString())}</generated_at><daily_action><id>${escXml(a.id)}</id><name>${escXml(a.name)}</name><headline>${escXml(a.headline)}</headline><description>${escXml(a.description_text)}</description><discount>${escXml(a.discount_text)}</discount><image_url>${escXml(a.image_url)}</image_url><cta_label>${escXml(a.cta_label)}</cta_label><cta_url>${escXml(a.cta_url)}</cta_url><valid_from>${escXml(a.valid_from)}</valid_from><valid_until>${escXml(a.valid_until)}</valid_until></daily_action></wallboard>`);
  } catch(e){ next(e); }
});

router.get("/wallboard/queue.json", async (req,res,next)=>{
  try{
    const location=await resolveQueueLocation(req.query.location_id);
    if(!location)return res.json({version:"1.0",generated_at:new Date().toISOString(),location:null,waiting:[],ready:[]});
    const rows=await queueRows(location.id);
    res.setHeader("Cache-Control","no-store");
    res.json({version:"1.0",generated_at:new Date().toISOString(),date:new Date().toLocaleDateString("en-CA",{timeZone:"Europe/Budapest"}),location,waiting:rows.filter((r:any)=>r.column==='waiting'),ready:rows.filter((r:any)=>r.column==='ready')});
  }catch(e){next(e)}
});

router.get("/wallboard/queue/workorder/:id.json", async (req,res,next)=>{
  try{
    await ensureKioskQueueSchema();
    const {rows}=await pool.query(`SELECT id::text work_order_id,work_order_number,kiosk_queue_no,kiosk_queue_code,kiosk_queue_date,status FROM work_orders WHERE id=$1::uuid AND COALESCE(source_snapshot->>'source','')='kiosk' LIMIT 1`,[req.params.id]);
    if(!rows[0])return res.status(404).json({ok:false,error:"kiosk_queue_not_found"});
    res.setHeader("Cache-Control","no-store");
    res.json({ok:true,...rows[0]});
  }catch(e){next(e)}
});

function queueCard(r:any){
  const photo=r.specialist_photo_url?`<img class="avatar" src="${escHtml(r.specialist_photo_url)}" alt="">`:`<div class="avatar placeholder">✦</div>`;
  return `<article class="queue-card"><div class="queue-code">${escHtml(r.kiosk_queue_code)}</div><div class="person">${photo}<div><div class="label">Szakember</div><div class="name">${escHtml(r.specialist_name)}</div></div></div></article>`;
}

router.get("/wallboard", async (req,res,next)=>{
  try {
    const location=await resolveQueueLocation(req.query.location_id);
    const rows=location?await queueRows(location.id):[];
    const waiting=rows.filter((r:any)=>r.column==='waiting');
    const ready=rows.filter((r:any)=>r.column==='ready');
    const waitingHtml=waiting.length?waiting.map(queueCard).join(""):`<div class="empty">Nincs várakozó kioskos rendelés.</div>`;
    const readyHtml=ready.length?ready.map(queueCard).join(""):`<div class="empty">Jelenleg nincs hívható sorszám.</div>`;
    res.removeHeader("X-Frame-Options");
    res.setHeader("Content-Security-Policy","frame-ancestors *");
    res.setHeader("Cache-Control","no-cache");
    res.type("html").send(`<!doctype html><html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5"><title>Kleopátra Sorhívó</title><style>*{box-sizing:border-box}html,body{margin:0;width:100%;min-height:100%;background:#120b10;color:#fff;font-family:Inter,Arial,sans-serif}.screen{min-height:100vh;padding:2.2vw;background:radial-gradient(circle at 15% 10%,#5c173e 0,#24120e 42%,#120907 100%)}header{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:2vw}.brand{font-size:1.25vw;letter-spacing:.18em;text-transform:uppercase;opacity:.72}.salon{font-size:1.1vw;opacity:.58}.columns{display:grid;grid-template-columns:1fr 1fr;gap:2vw}.column{background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.12);border-radius:1.7vw;padding:1.5vw;min-height:78vh;box-shadow:0 1vw 3vw rgba(0,0,0,.25)}.column h2{margin:.2vw 0 1.3vw;font-size:2.2vw}.column.ready h2{color:#ffe0a3}.queue-card{display:flex;align-items:center;justify-content:space-between;gap:1.2vw;background:rgba(0,0,0,.24);border:1px solid rgba(255,255,255,.11);border-radius:1.2vw;padding:1.1vw 1.3vw;margin-bottom:1vw}.queue-code{font-size:2.7vw;font-weight:900;letter-spacing:.035em;min-width:8.2ch}.person{display:flex;align-items:center;gap:.9vw;min-width:48%}.avatar{width:4vw;height:4vw;border-radius:50%;object-fit:cover;border:2px solid rgba(255,255,255,.25)}.avatar.placeholder{display:grid;place-items:center;background:#3c2632;font-size:1.6vw}.label{font-size:.8vw;letter-spacing:.12em;text-transform:uppercase;opacity:.55}.name{font-size:1.25vw;font-weight:700;margin-top:.15vw}.empty{opacity:.5;text-align:center;padding:8vh 2vw;font-size:1.2vw}.footer{position:fixed;right:2vw;bottom:.9vw;font-size:.8vw;opacity:.45}@media(max-aspect-ratio:1/1){.columns{grid-template-columns:1fr}.column{min-height:auto}.queue-code{font-size:5vw}.column h2{font-size:4vw}.name{font-size:2.5vw}.avatar{width:7vw;height:7vw}.brand,.salon{font-size:2vw}}</style></head><body><main class="screen"><header><div><div class="brand">Kleopátra • KIOSK sorhívó</div></div><div class="salon">${escHtml(location?.name||"")}</div></header><section class="columns"><section class="column"><h2>Várakozik</h2>${waitingHtml}</section><section class="column ready"><h2>Mehet a szakemberhez</h2>${readyHtml}</section></section></main><div class="footer">Automatikus frissítés • 5 mp</div></body></html>`);
  } catch(e){ next(e); }
});

router.get("/birthdays", async (_req,res)=>{
  try {
    const { rows } = await pool.query(`
      WITH today AS (SELECT timezone('Europe/Budapest', now())::date AS d), celebrating AS (
        SELECT DISTINCT a.client_id::text FROM appointments a JOIN clients c ON c.id::text=a.client_id::text CROSS JOIN today t
        WHERE timezone('Europe/Budapest',a.start_time)::date=t.d AND lower(COALESCE(a.status,'')) NOT IN ('cancelled','canceled','no_show')
          AND COALESCE(to_jsonb(c)->>'birth_date','') ~ '^\\d{4}-\\d{2}-\\d{2}'
          AND EXTRACT(MONTH FROM substring(to_jsonb(c)->>'birth_date' from 1 for 10)::date)=EXTRACT(MONTH FROM t.d)
          AND EXTRACT(DAY FROM substring(to_jsonb(c)->>'birth_date' from 1 for 10)::date)=EXTRACT(DAY FROM t.d)
      ) SELECT count(*)::int AS count FROM celebrating
    `);
    const count=Math.max(0,Number(rows?.[0]?.count||0));
    const message=count===1?"Ma egy vendégünk születésnapját ünnepeljük. Boldog születésnapot kíván a Kleopátra csapata!":count>1?`Ma ${count} vendégünk születésnapját ünnepeljük. Boldog születésnapot kíván a Kleopátra csapata!`:"";
    res.setHeader("Cache-Control","public, max-age=60, stale-while-revalidate=180");
    res.json({celebrating:count>0,count,message,date:new Date().toLocaleDateString("en-CA",{timeZone:"Europe/Budapest"}),privacy:"no_personal_identifiers",generated_at:new Date().toISOString()});
  } catch (e:any) { res.json({celebrating:false,count:0,message:"",privacy:"no_personal_identifiers",generated_at:new Date().toISOString(),error:String(e?.message||e)}); }
});

router.get("/runtime-settings", requireAdmin, async (_req,res,next)=>{
  try { const [settings,render]=await Promise.all([getRuntimeSettingsSnapshot(),getRenderInfrastructureStatus()]);res.json({settings,render,mailbox:getComplaintMailboxStatus()}); } catch(e){ next(e); }
});
router.put("/runtime-settings", requireAdmin, async (req:AuthRequest,res,next)=>{
  try { const actor=String(req.user?.email||req.user?.id||"admin");await saveRuntimeSettings(req.body?.settings||{},actor);restartComplaintMailboxWorker();const [settings,render]=await Promise.all([getRuntimeSettingsSnapshot(),getRenderInfrastructureStatus()]);res.json({ok:true,settings,render,mailbox:getComplaintMailboxStatus()}); } catch(e){ next(e); }
});
router.post("/runtime-settings/github/apply", requireAdmin, async (_req,res,next)=>{ try { res.json(await applyGitHubReleaseEnvironment()); } catch(e){ next(e); } });
router.post("/runtime-settings/render/verify", requireAdmin, async (_req,res,next)=>{ try { res.json(await getRenderInfrastructureStatus()); } catch(e){ next(e); } });
router.post("/runtime-settings/render/apply", requireAdmin, async (_req,res,next)=>{ try { res.json(await applyRenderHighAvailability()); } catch(e){ next(e); } });

export default router;
