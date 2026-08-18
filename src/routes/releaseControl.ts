import { Router } from "express";
import db from "../db";
import type { AuthRequest } from "../middleware/auth";
import { verifyEmailTransport } from "../mailer";
import { getComplaintMailboxStatus } from "../services/complaintMailbox";

const router = Router();

export type GateStatus = "pass" | "warning" | "fail" | "pending";
type Gate = {
  key: string;
  group: string;
  label: string;
  status: GateStatus;
  blocking: boolean;
  editable?: boolean;
  message: string;
  evidence?: string | null;
  source?: string | null;
  updated_at?: string | null;
  updated_by?: string | null;
};

const MANUAL_GATES = [
  ["version.frontend", "Verzió és build", "Frontend Git SHA / deploy"],
  ["tests.backend", "Automatikus tesztek", "Backend unit / contract tesztek"],
  ["build.backend", "Automatikus tesztek", "Backend production build"],
  ["tests.frontend", "Automatikus tesztek", "Frontend tesztek"],
  ["build.frontend", "Automatikus tesztek", "Frontend production build"],
  ["tests.integration", "Automatikus tesztek", "Integrációs / E2E tesztek"],
  ["tests.financial", "Automatikus tesztek", "Pénzügyi integritás"],
  ["tests.saas", "Biztonság", "SaaS cross-tenant izoláció"],
  ["tests.rbac", "Biztonság", "RBAC / telephely izoláció"],
  ["backup.restore", "Üzemeltetés", "Backup + restore próba"],
  ["rollback.drill", "Üzemeltetés", "Rollback eljárás próbája"],
  ["hotfix.consolidation", "Kódstabilitás", "Hotfix / recovery route konszolidáció"],
  ["uat.signoff", "Jóváhagyás", "Manuális UAT sign-off"],
  ["approval.production", "Jóváhagyás", "Production release approval"],
] as const;

const AUTOMATED_KEYS = new Set([
  "version.frontend",
  "tests.backend",
  "build.backend",
  "tests.frontend",
  "build.frontend",
  "tests.integration",
  "tests.financial",
  "tests.saas",
  "tests.rbac",
  "backup.restore",
]);

let ensurePromise: Promise<void> | null = null;
function ensureSchema() {
  if (!ensurePromise) ensurePromise = db.query(`
    CREATE TABLE IF NOT EXISTS release_control_evidence(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      release_ref text NOT NULL,
      check_key text NOT NULL,
      status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pass','warning','fail','pending')),
      evidence text,
      source text NOT NULL DEFAULT 'manual',
      updated_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(release_ref,check_key)
    );
    CREATE INDEX IF NOT EXISTS idx_release_control_evidence_ref ON release_control_evidence(release_ref,updated_at DESC);
  `).then(() => undefined).catch(error => { ensurePromise = null; throw error; });
  return ensurePromise;
}

function releaseRef() {
  return String(process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT_SHA || process.env.COMMIT_SHA || "unversioned").trim();
}
export function currentReleaseRef() { return releaseRef(); }
function frontendRef() {
  return String(process.env.FRONTEND_RELEASE_SHA || process.env.FRONTEND_GIT_COMMIT || "").trim();
}
async function tableExists(table: string) {
  try { const r = await db.query(`SELECT to_regclass($1) IS NOT NULL ok`, [`public.${table}`]); return Boolean(r.rows[0]?.ok); }
  catch { return false; }
}
async function safeCount(sql: string, params: any[] = []) {
  try { const r = await db.query(sql, params); return Number(Object.values(r.rows[0] || {})[0] || 0); }
  catch { return 0; }
}
function actor(req: AuthRequest) { return String(req.user?.email || req.user?.id || "system"); }
function manualKeyAllowed(key: string) { return MANUAL_GATES.some(([k]) => k === key); }

export async function recordReleaseEvidence(input: {
  release_ref: string;
  key: string;
  status: GateStatus;
  evidence?: string | null;
  source: string;
  updated_by: string;
}) {
  await ensureSchema();
  if (!manualKeyAllowed(input.key)) throw new Error(`Ismeretlen release gate: ${input.key}`);
  if (!["pass", "warning", "fail", "pending"].includes(input.status)) throw new Error(`Érvénytelen gate státusz: ${input.status}`);
  const r = await db.query(`INSERT INTO release_control_evidence(release_ref,check_key,status,evidence,source,updated_by,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,now())
    ON CONFLICT(release_ref,check_key) DO UPDATE SET status=EXCLUDED.status,evidence=EXCLUDED.evidence,source=EXCLUDED.source,updated_by=EXCLUDED.updated_by,updated_at=now()
    RETURNING *`, [
      String(input.release_ref || releaseRef()).trim() || releaseRef(),
      input.key,
      input.status,
      String(input.evidence || "").trim().slice(0, 4000) || null,
      String(input.source || "unknown").trim().slice(0, 300) || "unknown",
      String(input.updated_by || "system").trim().slice(0, 300) || "system",
    ]);
  return r.rows[0];
}

async function automaticGates(): Promise<{ gates: Gate[]; meta: any }> {
  const gates: Gate[] = [];
  const add = (g: Gate) => gates.push(g);
  const ref = releaseRef();
  const feRef = frontendRef();
  let dbLatency = 0;
  try {
    const started = Date.now();
    await db.query("SELECT 1");
    dbLatency = Date.now() - started;
    add({ key:"runtime.database", group:"Runtime", label:"PostgreSQL kapcsolat", status:"pass", blocking:true, message:`Adatbázis elérhető (${dbLatency} ms).`, source:"runtime" });
  } catch (error:any) {
    add({ key:"runtime.database", group:"Runtime", label:"PostgreSQL kapcsolat", status:"fail", blocking:true, message:error?.message || "Az adatbázis nem elérhető.", source:"runtime" });
  }

  const migrationsTable = await tableExists("schema_migrations");
  let migrationCount = 0;
  let lastMigration: any = null;
  if (migrationsTable) {
    migrationCount = await safeCount(`SELECT COUNT(*) FROM schema_migrations`);
    try { lastMigration = (await db.query(`SELECT version,description,applied_at FROM schema_migrations ORDER BY applied_at DESC NULLS LAST,version DESC LIMIT 1`)).rows[0] || null; } catch {}
  }
  add({ key:"runtime.migrations", group:"Adatbázis", label:"Migrációs állapot", status:migrationsTable && migrationCount>0?"pass":"fail", blocking:true, message:migrationsTable?`${migrationCount} migráció naplózva${lastMigration?.version?`; utolsó: ${lastMigration.version}`:""}.`:"A schema_migrations tábla hiányzik.", source:"runtime" });

  const backendVersioned = ref !== "unversioned";
  add({ key:"version.backend", group:"Verzió és build", label:"Backend Git SHA", status:backendVersioned?"pass":"fail", blocking:true, message:backendVersioned?ref:"A futó backend release commitja nem azonosítható.", evidence:backendVersioned?ref:null, source:"runtime" });

  try {
    const email = await verifyEmailTransport();
    const status: GateStatus = email.ok ? "pass" : "fail";
    add({ key:"integration.smtp", group:"Integrációk", label:"SMTP / e-mail", status, blocking:true, message:email.ok?"SMTP kapcsolat és hitelesítés rendben.":`SMTP nem küldéskész: ${email.mode}${email.error_code?` (${email.error_code})`:""}.`, source:"runtime" });
  } catch (error:any) {
    add({ key:"integration.smtp", group:"Integrációk", label:"SMTP / e-mail", status:"fail", blocking:true, message:error?.message || "SMTP ellenőrzési hiba.", source:"runtime" });
  }

  const mailbox = getComplaintMailboxStatus();
  const imapOk = mailbox.enabled && Boolean(mailbox.lastSuccessAt) && !mailbox.lastError;
  add({ key:"integration.imap", group:"Integrációk", label:"Panasz IMAP", status:imapOk?"pass":"fail", blocking:true, message:imapOk?`IMAP működik; utolsó siker: ${mailbox.lastSuccessAt}.`:mailbox.enabled?`IMAP még nem igazoltan működőképes: ${mailbox.lastError || "nincs sikeres szinkron"}.`:"COMPLAINT_IMAP nincs konfigurálva.", source:"runtime" });

  const navSettings = await tableExists("nav_online_invoice_settings");
  const navQueue = await tableExists("nav_invoice_queue");
  const activeNav = navSettings ? await safeCount(`SELECT COUNT(*) FROM nav_online_invoice_settings WHERE active=true`) : 0;
  add({ key:"integration.nav", group:"Integrációk", label:"NAV Online Számla", status:navSettings && navQueue && activeNav>0?"pass":"fail", blocking:true, message:navSettings && navQueue?activeNav>0?`${activeNav} aktív NAV konfiguráció; queue tábla elérhető.`:"Nincs aktív NAV technikai konfiguráció.":"A NAV runtime séma hiányos.", source:"runtime" });

  const pushTable = await tableExists("app_runtime_secrets");
  const pushSecrets = pushTable ? await safeCount(`SELECT COUNT(*) FROM app_runtime_secrets WHERE secret_key IN('vapid_public_key','vapid_private_key')`) : 0;
  const pushEnv = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
  add({ key:"integration.push", group:"Integrációk", label:"Mobil push / VAPID", status:pushEnv || pushSecrets>=2?"pass":"fail", blocking:true, message:pushEnv?"VAPID kulcsok környezeti változókból elérhetők.":pushSecrets>=2?"VAPID kulcsok runtime secrets táblából elérhetők.":"VAPID kulcspár nem található.", source:"runtime" });

  const wallboardCampaigns = await tableExists("daily_action_campaigns");
  add({ key:"integration.wallboard", group:"Integrációk", label:"WallBoard / napi akció", status:wallboardCampaigns?"pass":"fail", blocking:true, message:wallboardCampaigns?"A napi akció / WallBoard runtime adatforrás elérhető.":"A daily_action_campaigns runtime tábla hiányzik.", source:"runtime" });

  const mobileSettings = await tableExists("mobile_app_settings");
  const mobileSubscriptions = await tableExists("app_push_subscriptions");
  add({ key:"integration.mobile_app", group:"Integrációk", label:"Mobilapp runtime", status:mobileSettings && mobileSubscriptions?"pass":"fail", blocking:true, message:mobileSettings && mobileSubscriptions?"A mobilapp beállítás- és push-előfizetés táblák elérhetők.":"A mobilapp runtime séma hiányos.", source:"runtime" });

  const products = await tableExists("products");
  const productGroups = await tableExists("product_groups");
  const productCategories = await tableExists("product_categories");
  add({ key:"integration.webshop", group:"Integrációk", label:"Webshop runtime", status:products && productGroups && productCategories?"pass":"fail", blocking:true, message:products && productGroups && productCategories?"A webshop termék- és taxonómia-törzsek elérhetők.":"A webshop termék/taxonómia runtime séma hiányos.", source:"runtime" });

  let apmLastSnapshotAt: string | null = null;
  let apmSnapshotAgeMinutes: number | null = null;
  const apmSnapshotsReady = await tableExists("apm_metric_snapshots");
  if (apmSnapshotsReady) {
    try {
      const row = (await db.query(`SELECT captured_at FROM apm_metric_snapshots ORDER BY captured_at DESC LIMIT 1`)).rows[0];
      if (row?.captured_at) {
        apmLastSnapshotAt = new Date(row.captured_at).toISOString();
        apmSnapshotAgeMinutes = Math.max(0, Math.round(((Date.now() - new Date(row.captured_at).getTime()) / 60_000) * 10) / 10);
      }
    } catch {}
  }
  const apmReady = apmSnapshotAgeMinutes != null && apmSnapshotAgeMinutes <= 5;
  add({
    key:"infrastructure.observability",
    group:"Infrastruktúra",
    label:"Observability / APM aktív",
    status:apmReady?"pass":"fail",
    blocking:true,
    message:apmReady?`APM worker aktív; utolsó snapshot ${apmSnapshotAgeMinutes} perce készült.`:apmSnapshotsReady?"Az APM snapshot túl régi vagy még nem készült el.":"Az APM runtime séma még nem jött létre.",
    evidence:apmLastSnapshotAt,
    source:"runtime",
  });

  const instanceCount = Number(process.env.RENDER_INSTANCE_COUNT || process.env.WEB_CONCURRENCY || 1);
  const dbHa = process.env.DATABASE_HA_ENABLED === "1";
  const haReady = instanceCount >= 2 && dbHa;
  add({ key:"infrastructure.ha", group:"Infrastruktúra", label:"Magas rendelkezésre állás", status:haReady?"pass":"fail", blocking:true, message:haReady?`${instanceCount} API instance és HA adatbázis deklarálva.`:`Nem teljes a HA: API instance=${instanceCount}, database_ha=${dbHa?"igen":"nem"}.`, source:"runtime" });

  const hotfixMarkers = ["api500Hotfix","LifecycleHotfix","LiveRecovery","ReadinessHotfix","RuntimeHotfix"];
  add({ key:"runtime.hotfix-awareness", group:"Kódstabilitás", label:"Hotfix-konszolidáció kapu", status:"warning", blocking:false, message:`A release gate külön bizonyítékot kér a hotfix/recovery rétegek konszolidációjára (${hotfixMarkers.length} ismert kategória).`, source:"policy" });

  return { gates, meta:{ backend_ref:ref, frontend_ref:feRef || null, node_version:process.version, environment:process.env.NODE_ENV || "unknown", database_latency_ms:dbLatency, migration_count:migrationCount, last_migration:lastMigration, apm_last_snapshot_at:apmLastSnapshotAt, apm_snapshot_age_minutes:apmSnapshotAgeMinutes, instance_count:instanceCount, database_ha_enabled:dbHa } };
}

async function evidenceGates(ref: string): Promise<Gate[]> {
  await ensureSchema();
  const rows = (await db.query(`SELECT check_key,status,evidence,source,updated_by,updated_at FROM release_control_evidence WHERE release_ref=$1`, [ref])).rows;
  const map = new Map(rows.map((r:any) => [String(r.check_key), r]));

  if (await tableExists("release_manual_signoffs")) {
    try {
      const signoff = (await db.query(`SELECT result,notes,tester_name,created_at FROM release_manual_signoffs WHERE release_ref=$1 ORDER BY created_at DESC LIMIT 1`, [ref])).rows[0];
      if (signoff && !map.has("uat.signoff")) {
        const passed = ["pass","passed","approved","go","ok"].includes(String(signoff.result || "").toLowerCase());
        map.set("uat.signoff", { check_key:"uat.signoff", status:passed?"pass":"fail", evidence:`${signoff.tester_name || "UAT"}: ${signoff.notes || signoff.result}`, source:"vir-spec-parity", updated_by:signoff.tester_name, updated_at:signoff.created_at });
      }
    } catch {}
  }

  return MANUAL_GATES.map(([key,group,label]) => {
    const row:any = map.get(key);
    return {
      key,
      group,
      label,
      status:(row?.status || "pending") as GateStatus,
      blocking:true,
      editable:!AUTOMATED_KEYS.has(key),
      message:row?.evidence || (AUTOMATED_KEYS.has(key) ? "GitHub Actions bizonyíték még nem érkezett ehhez a futó release-hez." : "Kötelező release-bizonyíték még nincs rögzítve."),
      evidence:row?.evidence || null,
      source:row?.source || (AUTOMATED_KEYS.has(key) ? "github-actions" : "manual"),
      updated_by:row?.updated_by || null,
      updated_at:row?.updated_at || null,
    };
  });
}

router.use(async (_req,_res,next) => { try { await ensureSchema(); next(); } catch (error) { next(error); } });

router.get("/", async (_req, res, next) => {
  try {
    const auto = await automaticGates();
    const manual = await evidenceGates(auto.meta.backend_ref);
    const autoKeys = new Set(auto.gates.map(g => g.key));
    const gates = [...auto.gates, ...manual.filter(g => !autoKeys.has(g.key))];
    const blocking = gates.filter(g => g.blocking);
    const blockers = blocking.filter(g => g.status !== "pass");
    const summary = {
      total:gates.length,
      pass:gates.filter(g=>g.status==="pass").length,
      warning:gates.filter(g=>g.status==="warning").length,
      fail:gates.filter(g=>g.status==="fail").length,
      pending:gates.filter(g=>g.status==="pending").length,
      blocking_total:blocking.length,
      blocking_open:blockers.length,
    };
    res.json({ generated_at:new Date().toISOString(), release_ref:auto.meta.backend_ref, release_ready:blockers.length===0, decision:blockers.length===0?"GO":"NO-GO", summary, blockers:blockers.map(g=>({key:g.key,label:g.label,status:g.status,message:g.message})), meta:auto.meta, gates });
  } catch (error) { next(error); }
});

router.post("/evidence", async (req:AuthRequest,res,next) => {
  try {
    const key = String(req.body?.key || "").trim();
    if (!manualKeyAllowed(key)) return res.status(400).json({message:"Ismeretlen release gate."});
    if (AUTOMATED_KEYS.has(key)) return res.status(403).json({message:"Ezt a release gate-et kizárólag a hitelesített GitHub Actions workflow írhatja."});
    const status = String(req.body?.status || "pending").trim() as GateStatus;
    if (!["pass","warning","fail","pending"].includes(status)) return res.status(400).json({message:"Érvénytelen gate státusz."});
    const ref = String(req.body?.release_ref || releaseRef()).trim() || releaseRef();
    const row = await recordReleaseEvidence({
      release_ref: ref,
      key,
      status,
      evidence: String(req.body?.evidence || "").trim(),
      source: String(req.body?.source || "vir-admin").trim() || "vir-admin",
      updated_by: actor(req),
    });
    res.json(row);
  } catch (error) { next(error); }
});

router.delete("/evidence/:key", async (req:AuthRequest,res,next) => {
  try {
    const key = String(req.params.key || "");
    if (!manualKeyAllowed(key)) return res.status(400).json({message:"Ismeretlen release gate."});
    if (AUTOMATED_KEYS.has(key)) return res.status(403).json({message:"Automatikus GitHub Actions bizonyíték kézzel nem törölhető."});
    const ref = String(req.query.release_ref || releaseRef()).trim();
    await db.query(`DELETE FROM release_control_evidence WHERE release_ref=$1 AND check_key=$2`, [ref,key]);
    res.json({ok:true,release_ref:ref,key,cleared_by:actor(req)});
  } catch (error) { next(error); }
});

export default router;
