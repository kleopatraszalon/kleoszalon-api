import { Router } from "express";
import db from "../db";
import { sendEmail } from "../mailer";
import { sendSms } from "../sms";
import webpush from "web-push";
import axios from "axios";
export const publicDailyActionsRouter = Router();
const router = Router();
const publicFrontendUrl = (process.env.FRONTEND_URL || "https://kleoszalon-frontend.onrender.com").replace(/\/$/, "");
const kleopatraLogoUrl = `${publicFrontendUrl}/kleopatra-logo.png`;
async function ensure() {
  await db.query(`CREATE TABLE IF NOT EXISTS daily_action_campaigns(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL,headline text NOT NULL,description_html text NOT NULL,image_url text,cta_label text DEFAULT 'Foglalok',cta_url text DEFAULT '/foglalas',discount_text text,valid_from timestamptz NOT NULL,valid_until timestamptz NOT NULL,audience jsonb DEFAULT '{"type":"all"}'::jsonb,channels jsonb DEFAULT '["app"]'::jsonb,status text DEFAULT 'draft',recipient_count int DEFAULT 0,sent_email int DEFAULT 0,sent_sms int DEFAULT 0,sent_push int DEFAULT 0,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS headline text;ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS description_html text;ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS image_url text;ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS cta_label text DEFAULT 'Foglalok';ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS cta_url text DEFAULT '/foglalas';ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS discount_text text;ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS valid_from timestamptz;ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS valid_until timestamptz;ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS audience jsonb DEFAULT '{"type":"all"}'::jsonb;ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS channels jsonb DEFAULT '["app"]'::jsonb;ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS status text DEFAULT 'draft';ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS recipient_count int DEFAULT 0;ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS sent_email int DEFAULT 0;ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS sent_sms int DEFAULT 0;ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS sent_push int DEFAULT 0;ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE daily_action_campaigns ALTER COLUMN image_url TYPE text USING image_url::text;ALTER TABLE daily_action_campaigns ALTER COLUMN description_html TYPE text USING description_html::text;ALTER TABLE daily_action_campaigns ALTER COLUMN headline TYPE text USING headline::text;
ALTER TABLE daily_action_campaigns DROP CONSTRAINT IF EXISTS daily_action_campaign_name_uq;DROP INDEX IF EXISTS daily_action_campaign_name_uq;
CREATE TABLE IF NOT EXISTS app_push_subscriptions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),endpoint text UNIQUE NOT NULL,subscription jsonb NOT NULL,client_id uuid,active boolean DEFAULT true,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());ALTER TABLE app_push_subscriptions ADD COLUMN IF NOT EXISTS last_seen_at timestamptz DEFAULT now();ALTER TABLE app_push_subscriptions ADD COLUMN IF NOT EXISTS last_reengagement_at timestamptz;`);
}
function campaignInput(body: any) {
  const b = body || {};
  const name = String(b.name || "").trim();
  const headline = String(b.headline || "").trim();
  const descriptionHtml = String(b.description_html || "").trim();
  const validFrom = new Date(b.valid_from);
  const validUntil = new Date(b.valid_until);
  const channels = Array.isArray(b.channels)
    ? b.channels.filter((x: unknown) => ["email", "sms", "app"].includes(String(x)))
    : [];
  if (!name || !headline || !descriptionHtml)
    return { error: "A kampánynév, a főcím és az akció leírása kötelező." };
  if (Number.isNaN(validFrom.getTime()) || Number.isNaN(validUntil.getTime()))
    return { error: "Adjon meg érvényes kezdő és záró időpontot." };
  if (validUntil <= validFrom)
    return { error: "Az akció vége legyen későbbi a kezdésnél." };
  if (!channels.length)
    return { error: "Válasszon legalább egy kiküldési csatornát." };
  return { name, headline, descriptionHtml, validFrom, validUntil, channels };
}
async function recipients(a: any) {
  let w = `COALESCE(c.marketing_consent,false)=true`;
  if (a?.type === "new")
    w += ` AND c.created_at>=now()-interval '${Math.max(1, Number(a.days || 30))} days'`;
  if (a?.type === "inactive")
    w += ` AND COALESCE(c.altegio_last_visit,c.updated_at)<now()-interval '${Math.max(1, Number(a.days || 180))} days'`;
  if (a?.type === "loyalty")
    w += ` AND EXISTS(SELECT 1 FROM loyalty_program_members pm WHERE pm.client_id=c.id AND pm.tier_code=ANY(ARRAY[${(a.tiers || ["gold"]).map((x: string) => `'${String(x).replace(/'/g, "")}'`).join(",")}]))`;
  if (a?.type === "pass_holders")
    w += ` AND EXISTS(SELECT 1 FROM loyalty_accounts la JOIN loyalty_passes lp ON lp.account_id=la.id WHERE la.customer_id::text=c.id::text AND lp.status='active')`;
  return db.query(
    `SELECT c.id,COALESCE(NULLIF(c.full_name,''),c.name,'Vendég')name,c.email,c.phone,c.email_consent,c.sms_consent FROM clients c WHERE ${w} LIMIT 5000`,
  );
}
router.use(async (_q, _s, n) => {
  try {
    await ensure();
    n();
  } catch (e) {
    n(e);
  }
});
publicDailyActionsRouter.use(async (_q, _s, n) => {
  try {
    await ensure();
    n();
  } catch (e) {
    n(e);
  }
});
router.get("/", async (_q, res, n) => {
  try {
    res.json({
      campaigns: (
        await db.query(
          `SELECT * FROM daily_action_campaigns ORDER BY created_at DESC`,
        )
      ).rows,
      vapid_public_key: process.env.VAPID_PUBLIC_KEY || null,
    });
  } catch (e) {
    n(e);
  }
});
router.post("/audience-preview", async (req, res, n) => {
  try {
    const r = await recipients(req.body);
    res.json({
      count: r.rowCount,
      email: r.rows.filter((x) => x.email && x.email_consent).length,
      sms: r.rows.filter((x) => x.phone && x.sms_consent).length,
    });
  } catch (e) {
    n(e);
  }
});
router.post("/", async (req, res, n) => {
  try {
    const b = req.body,
      input = campaignInput(b);
    if ("error" in input) return res.status(400).json({ message: input.error });
    const
      { rows } = await db.query(
        `INSERT INTO daily_action_campaigns(name,headline,description_html,image_url,cta_label,cta_url,discount_text,valid_from,valid_until,audience,channels,status)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,'draft')RETURNING *`,
        [
          input.name,
          input.headline,
          input.descriptionHtml,
          b.image_url || null,
          b.cta_label || "Foglalok",
          b.cta_url || "/foglalas",
          b.discount_text || null,
          input.validFrom,
          input.validUntil,
          JSON.stringify(b.audience || { type: "all" }),
          JSON.stringify(input.channels),
        ],
      );
    res.status(201).json(rows[0]);
  } catch (e: any) {
    const diagnosticId = `DA-${Date.now().toString(36).toUpperCase()}`;
    console.error("[daily-action-save]", diagnosticId, e?.code, e?.message, e?.detail);
    const known: Record<string, string> = {
      "23505": "Ezzel a névvel már létezik akció. Frissítse az oldalt, majd próbálja újra.",
      "22P02": "Az akció egyik mezője érvénytelen formátumú.",
      "42703": "Az akciók adatbázissémája frissítésre szorul.",
      "22001": "A kampány egyik szöveges vagy képes mezője túl hosszú volt.",
    };
    res.status(500).json({
      code: "DAILY_ACTION_SAVE_FAILED",
      message: known[e?.code] || "Az akció mentése nem sikerült. A hibát naplóztuk.",
      diagnostic_id: diagnosticId,
      database_code: e?.code || null,
    });
  }
});
router.patch("/:id", async (req, res, n) => {
  try {
    const b = req.body,
      input = campaignInput(b);
    if ("error" in input) return res.status(400).json({ message: input.error });
    const
      { rows } = await db.query(
        `UPDATE daily_action_campaigns SET name=$2,headline=$3,description_html=$4,image_url=$5,cta_label=$6,cta_url=$7,discount_text=$8,valid_from=$9,valid_until=$10,audience=$11::jsonb,channels=$12::jsonb,updated_at=now() WHERE id=$1::uuid RETURNING *`,
        [
          req.params.id,
          input.name,
          input.headline,
          input.descriptionHtml,
          b.image_url || null,
          b.cta_label || "Foglalok",
          b.cta_url || "/foglalas",
          b.discount_text || null,
          input.validFrom,
          input.validUntil,
          JSON.stringify(b.audience || { type: "all" }),
          JSON.stringify(input.channels),
        ],
      );
    if (!rows[0]) return res.status(404).json({ message: "Az akció nem található." });
    res.json(rows[0]);
  } catch (e: any) {
    const diagnosticId = `DA-${Date.now().toString(36).toUpperCase()}`;
    console.error("[daily-action-update]", diagnosticId, e?.code, e?.message, e?.detail);
    res.status(500).json({code:"DAILY_ACTION_UPDATE_FAILED",message:"Az akció módosítása nem sikerült. A hibát naplóztuk.",diagnostic_id:diagnosticId,database_code:e?.code||null});
  }
});
router.post("/:id/publish", async (req, res, n) => {
  try {
    const c = (
      await db.query(`SELECT * FROM daily_action_campaigns WHERE id=$1::uuid`, [
        req.params.id,
      ])
    ).rows[0];
    if (!c) return res.status(404).json({ message: "Az akció nem található." });
    const r = await recipients(c.audience),
      channels: string[] = c.channels || [];
    let email = 0,
      sms = 0,
      push = 0,
      pushFailures = 0;
    for (const x of r.rows) {
      if (channels.includes("email") && x.email && x.email_consent)
        try {
          await sendEmail({
            to: x.email,
            subject: c.headline,
            text: c.headline,
            html: `<div style="margin:0;background:#f5f0eb;padding:28px;font-family:Arial,sans-serif;color:#251a1f"><div style="max-width:680px;margin:auto;background:#fff;border-radius:18px;overflow:hidden;border:1px solid #e9ddd3"><div style="padding:22px;text-align:center;border-bottom:1px solid #eadfce"><img src="${kleopatraLogoUrl}" alt="Kleopátra Szépségszalonok" style="display:block;width:100%;max-width:420px;height:auto;margin:0 auto"/></div>${c.image_url ? `<img src="${c.image_url}" alt="" style="display:block;width:100%;max-height:360px;object-fit:cover">` : ""}<div style="padding:34px"><h1 style="font-family:Georgia,serif;color:#39251f">${c.headline}</h1>${c.description_html}<p><a href="${c.cta_url}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:#17100d;color:#fff;text-decoration:none;font-weight:bold">${c.cta_label}</a></p></div></div></div>`,
          });
          email++;
        } catch {}
      if (channels.includes("sms") && x.phone && x.sms_consent)
        try {
          await sendSms({
            to: x.phone,
            text: `Kleopátra: ${c.headline}. ${c.discount_text || ""} Foglalás: ${c.cta_url}`,
          });
          sms++;
        } catch {}
    }
    if (
      channels.includes("app") &&
      process.env.VAPID_PUBLIC_KEY &&
      process.env.VAPID_PRIVATE_KEY
    ) {
      webpush.setVapidDetails(
        process.env.VAPID_SUBJECT || "mailto:info@kleoszalon.hu",
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY,
      );
      for (const s of (
        await db.query(`SELECT * FROM app_push_subscriptions WHERE active=true`)
      ).rows)
        try {
          await webpush.sendNotification(
            s.subscription,
            JSON.stringify({
              title: c.headline,
              body: c.discount_text || "Új Kleopátra napi akció",
              image: c.image_url,
              url: "/kleopatra-app",
            }),
          );
          push++;
        } catch (pushError:any) {
          pushFailures++;
          // Csak a végleg megszűnt böngésző-feliratkozást kapcsoljuk ki. Egy
          // átmeneti hálózati/VAPID szolgáltatói hiba után a telefon aktív marad.
          if ([404,410].includes(Number(pushError?.statusCode||pushError?.status)))
            await db.query(
              `UPDATE app_push_subscriptions SET active=false WHERE id=$1`,
              [s.id],
            );
          else console.warn("[daily-action-push] transient failure",pushError?.statusCode,pushError?.message||pushError);
        }
    }
    await db.query(
      `UPDATE daily_action_campaigns SET status='published',recipient_count=$2,sent_email=$3,sent_sms=$4,sent_push=$5,updated_at=now()WHERE id=$1`,
      [c.id, r.rowCount, email, sms, push],
    );
    const activeDevices=Number((await db.query(`SELECT COUNT(*)::int count FROM app_push_subscriptions WHERE active=true`)).rows[0]?.count||0);
    res.json({ recipients: r.rowCount, email, sms, push, push_failures:pushFailures, active_devices:activeDevices, push_configured:Boolean(process.env.VAPID_PUBLIC_KEY&&process.env.VAPID_PRIVATE_KEY) });
  } catch (e) {
    n(e);
  }
});
publicDailyActionsRouter.get("/", async (_q, res, n) => {
  try {
    const { rows } = await db.query(
      `SELECT id,headline,description_html,image_url,cta_label,cta_url,discount_text,valid_from,valid_until FROM daily_action_campaigns WHERE status='published' AND valid_from<=now() AND valid_until>=now() ORDER BY valid_until`,
    );
    res.json({
      actions: rows,
      vapid_public_key: process.env.VAPID_PUBLIC_KEY || null,
    });
  } catch (e) {
    n(e);
  }
});
publicDailyActionsRouter.post("/subscribe", async (req, res, n) => {
  try {
    const s = req.body?.subscription;
    if (!s?.endpoint)
      return res
        .status(400)
        .json({ message: "Érvénytelen push-feliratkozás." });
    await db.query(
      `INSERT INTO app_push_subscriptions(endpoint,subscription,last_seen_at)VALUES($1,$2,now())ON CONFLICT(endpoint)DO UPDATE SET subscription=$2,active=true,last_seen_at=now(),updated_at=now()`,
      [s.endpoint, s],
    );
    res.json({ ok: true });
  } catch (e) {
    n(e);
  }
});
publicDailyActionsRouter.post("/heartbeat",async(req,res,n)=>{try{const endpoint=String(req.body?.endpoint||"").trim();if(endpoint)await db.query(`UPDATE app_push_subscriptions SET last_seen_at=now(),updated_at=now(),active=true WHERE endpoint=$1`,[endpoint]);res.json({ok:true,reminder_after_days:7})}catch(e){n(e)}});

const fallbackAssistant=(q:string)=>{const s=q.toLowerCase();if(s.includes("haj"))return"A haj állapotához és a kívánt eredményhez illő kezelést érdemes választani. Az app foglalójában jelölje ki az alapszolgáltatást, és megmutatjuk a kapcsolódó ajánlatokat.";if(s.includes("bőr")||s.includes("arc"))return"Érzékenység vagy bőrpanasz esetén először szakemberes állapotfelmérést javaslunk. Az ajánló csak a valós Kleopátra-katalógusból kínál kiegészítést.";if(s.includes("akció")||s.includes("kedvez"))return"Az aktuális akciókat a kezdőlapon és a szolgáltatás kiválasztása után is megmutatjuk. A foglalás véglegesítése előtt mindig látható a becsült összeg.";return"Segítek eligazodni a szolgáltatások, foglalás, bérletek és aktuális ajánlatok között. Írja le röviden, milyen eredményt szeretne, majd válasszon a katalógusból."};
publicDailyActionsRouter.post("/assistant",async(req,res,n)=>{try{const question=String(req.body?.question||"").trim().slice(0,500);if(question.length<3)return res.status(400).json({message:"Írjon legalább néhány szót."});const key=String(process.env.OPENAI_API_KEY||"").trim();if(!key)return res.json({answer:fallbackAssistant(question),ai_used:false});try{const r:any=await axios.post("https://api.openai.com/v1/responses",{model:process.env.BOOKING_RECOMMENDATION_MODEL||"gpt-5-mini",store:false,max_output_tokens:220,input:[{role:"system",content:[{type:"input_text",text:"Te a Kleopátra Beauty App magyar nyelvű szépségsegédje vagy. Röviden, kedvesen válaszolj. Ne diagnosztizálj, ne ígérj egészségügyi eredményt, és ne találj ki árat vagy akciót. Foglaláshoz és aktuális ajánlatokhoz irányíts az app katalógusába."}]},{role:"user",content:[{type:"input_text",text:question}]}]},{headers:{Authorization:`Bearer ${key}`},timeout:10000});const answer=String(r.data?.output?.flatMap((x:any)=>x.content||[]).find((x:any)=>x.type==="output_text")?.text||"").trim();return res.json({answer:answer||fallbackAssistant(question),ai_used:Boolean(answer)})}catch{return res.json({answer:fallbackAssistant(question),ai_used:false})}}catch(e){n(e)}});

let reminderRunning=false;
async function sendInactiveReminders(){if(reminderRunning||!process.env.VAPID_PUBLIC_KEY||!process.env.VAPID_PRIVATE_KEY)return;reminderRunning=true;try{await ensure();webpush.setVapidDetails(process.env.VAPID_SUBJECT||"mailto:info@kleoszalon.hu",process.env.VAPID_PUBLIC_KEY,process.env.VAPID_PRIVATE_KEY);const{rows}=await db.query(`SELECT id,subscription FROM app_push_subscriptions WHERE active=true AND last_seen_at<now()-interval '7 days' AND (last_reengagement_at IS NULL OR last_reengagement_at<last_seen_at OR last_reengagement_at<now()-interval '7 days') LIMIT 500`);for(const s of rows)try{await webpush.sendNotification(s.subscription,JSON.stringify({title:"A szépségre mindig érdemes időt szánni ✨",body:"Már egy hete nem találkoztunk. Nézze meg az új Kleopátra ajánlatokat, és ajándékozzon magának egy kis énidőt!",url:"/kleopatra-app"}));await db.query(`UPDATE app_push_subscriptions SET last_reengagement_at=now() WHERE id=$1`,[s.id])}catch{await db.query(`UPDATE app_push_subscriptions SET active=false WHERE id=$1`,[s.id])}}catch(e:any){console.warn("[app-reminder]",e?.message||e)}finally{reminderRunning=false}}
const reminderTimer=setInterval(()=>void sendInactiveReminders(),60*60*1000);reminderTimer.unref();setTimeout(()=>void sendInactiveReminders(),60_000).unref();
export default router;
