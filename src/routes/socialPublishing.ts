import { Router } from "express";
import db from "../db";
import { publicSocialAccountStatus } from "../social/config";
import { isUuid, socialText, stripSocialHtml } from "../social/media";
import { fetchTikTokPublishStatus, publishSocialPlatform, verifySocialAccounts } from "../social/socialPublisher";
import { SOCIAL_PLATFORMS, type SocialPlatform } from "../social/types";

const router = Router();
let ensurePromise: Promise<void> | null = null;
let queueBusy = false;

function ensureSchema() {
  if (!ensurePromise) {
    ensurePromise = db.query(`
      CREATE TABLE IF NOT EXISTS social_campaigns (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        source_type text NOT NULL DEFAULT 'manual',
        source_id uuid,
        name text NOT NULL,
        headline text NOT NULL,
        description text NOT NULL DEFAULT '',
        image_url text,
        video_url text,
        link_url text,
        platform_payloads jsonb NOT NULL DEFAULT '{}'::jsonb,
        scheduled_at timestamptz,
        status text NOT NULL DEFAULT 'draft',
        created_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS social_publications (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        campaign_id uuid NOT NULL REFERENCES social_campaigns(id) ON DELETE CASCADE,
        platform text NOT NULL,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        status text NOT NULL DEFAULT 'draft',
        scheduled_at timestamptz,
        attempts integer NOT NULL DEFAULT 0,
        external_id text,
        external_container_id text,
        external_url text,
        response jsonb,
        error text,
        published_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(campaign_id, platform)
      );
      CREATE INDEX IF NOT EXISTS social_publications_due_idx
        ON social_publications(status, scheduled_at)
        WHERE status IN ('scheduled','submitted','processing');
    `).then(() => undefined).catch(error => { ensurePromise = null; throw error; });
  }
  return ensurePromise;
}

router.use(async (_req, _res, next) => {
  try { await ensureSchema(); next(); } catch (error) { next(error); }
});

function selectedPlatforms(value: unknown): SocialPlatform[] {
  const raw = Array.isArray(value) ? value : [];
  return Array.from(new Set(raw.map(String).filter((value): value is SocialPlatform => SOCIAL_PLATFORMS.includes(value as SocialPlatform))));
}

function generatedPayloads(input: any) {
  const sourceType = socialText(input?.source_type, 40) || "manual";
  const headline = socialText(input?.headline || input?.name, 240) || (sourceType === "job" ? "Csatlakozz a Kleopátra csapatához!" : "Kleopátra ajánlat");
  const body = stripSocialHtml(input?.description || input?.description_html || input?.body).slice(0, 1800);
  const tags = sourceType === "job" ? "#kleopatra #állás #karrier #szépségipar" : "#kleopatra #szépség #szépségszalon #beauty";
  return {
    facebook: { caption: `${headline}${body ? `\n\n${body}` : ""}`.slice(0, 5000), cta_label: sourceType === "job" ? "Jelentkezem" : "Foglalok" },
    instagram: { caption: `${headline}${body ? `\n\n${body}` : ""}\n\n${tags}`.slice(0, 2200) },
    tiktok: {
      title: headline.slice(0, 90),
      caption: `${headline}${body ? `\n${body}` : ""}\n${tags}`.slice(0, 2100),
      privacy_level: "SELF_ONLY",
      disable_comment: false,
      disable_duet: false,
      disable_stitch: false,
      brand_organic_toggle: true,
      consent_confirmed: false,
    },
  };
}

function mergedPayloads(input: any) {
  const generated = generatedPayloads(input);
  const supplied = input?.platform_payloads && typeof input.platform_payloads === "object" ? input.platform_payloads : {};
  return Object.fromEntries(SOCIAL_PLATFORMS.map(platform => [platform, { ...(generated as any)[platform], ...(supplied[platform] || {}) }]));
}

async function sourceLists() {
  const jobs = await db.query(`SELECT id,position_name,description,requirements,status,created_at FROM hr_job_openings WHERE status IN ('published','draft') ORDER BY created_at DESC LIMIT 100`).then(result => result.rows).catch(() => []);
  const dailyActions = await db.query(`SELECT id,name,headline,description_html,image_url,cta_url,discount_text,valid_from,valid_until,status FROM daily_action_campaigns ORDER BY created_at DESC LIMIT 100`).then(result => result.rows).catch(() => []);
  return { jobs, daily_actions: dailyActions };
}

async function hydrateCampaign(id: string) {
  const campaign = (await db.query(`SELECT * FROM social_campaigns WHERE id=$1`, [id])).rows[0];
  if (!campaign) return null;
  campaign.publications = (await db.query(`SELECT * FROM social_publications WHERE campaign_id=$1 ORDER BY platform`, [id])).rows;
  return campaign;
}

async function refreshCampaignStatus(campaignId: string) {
  const statuses = (await db.query(`SELECT status FROM social_publications WHERE campaign_id=$1`, [campaignId])).rows.map(row => String(row.status));
  let status = "draft";
  if (statuses.length && statuses.every(value => value === "published")) status = "published";
  else if (statuses.some(value => ["processing", "submitted"].includes(value))) status = "processing";
  else if (statuses.some(value => value === "scheduled")) status = "scheduled";
  else if (statuses.some(value => value === "failed") && statuses.some(value => value === "published")) status = "partial";
  else if (statuses.length && statuses.every(value => value === "failed")) status = "failed";
  await db.query(`UPDATE social_campaigns SET status=$2,updated_at=now() WHERE id=$1`, [campaignId, status]);
}

async function claimPublication(id: string) {
  return (await db.query(`UPDATE social_publications SET status='processing',attempts=attempts+1,error=NULL,updated_at=now() WHERE id=$1 AND status IN ('scheduled','failed') RETURNING *`, [id])).rows[0];
}

async function executePublication(id: string) {
  const publication = await claimPublication(id);
  if (!publication) return null;
  const campaign = (await db.query(`SELECT * FROM social_campaigns WHERE id=$1`, [publication.campaign_id])).rows[0];
  if (!campaign) return null;
  try {
    const result = await publishSocialPlatform(publication.platform as SocialPlatform, campaign, publication.payload || {});
    await db.query(`UPDATE social_publications SET status=$2,external_id=$3,external_container_id=$4,external_url=$5,response=$6::jsonb,error=NULL,published_at=CASE WHEN $2='published' THEN now() ELSE published_at END,updated_at=now() WHERE id=$1`, [publication.id, result.status, result.external_id || null, result.external_container_id || null, result.external_url || null, JSON.stringify(result.response || {})]);
  } catch (error: any) {
    await db.query(`UPDATE social_publications SET status='failed',error=$2,response=$3::jsonb,updated_at=now() WHERE id=$1`, [publication.id, socialText(error?.response?.data?.error?.message || error?.response?.data?.message || error?.message || error, 1500), JSON.stringify(error?.response?.data || {})]);
  }
  await refreshCampaignStatus(String(campaign.id));
  return hydrateCampaign(String(campaign.id));
}

async function refreshTikTokSubmitted() {
  const submitted = await db.query(`SELECT * FROM social_publications WHERE platform='tiktok' AND status='submitted' ORDER BY updated_at LIMIT 12`);
  for (const publication of submitted.rows) {
    try {
      const result = await fetchTikTokPublishStatus(String(publication.external_id));
      const state = String(result?.data?.status || "");
      const publicIds = result?.data?.publicaly_available_post_id || result?.data?.publicly_available_post_id || [];
      if (state === "PUBLISH_COMPLETE") {
        await db.query(`UPDATE social_publications SET status='published',external_id=COALESCE($2,external_id),response=$3::jsonb,published_at=COALESCE(published_at,now()),error=NULL,updated_at=now() WHERE id=$1`, [publication.id, Array.isArray(publicIds) && publicIds[0] ? String(publicIds[0]) : null, JSON.stringify(result)]);
      } else if (state === "FAILED") {
        await db.query(`UPDATE social_publications SET status='failed',error=$2,response=$3::jsonb,updated_at=now() WHERE id=$1`, [publication.id, socialText(result?.data?.fail_reason || "TikTok publikálás sikertelen.", 1000), JSON.stringify(result)]);
      } else {
        await db.query(`UPDATE social_publications SET response=$2::jsonb,updated_at=now() WHERE id=$1`, [publication.id, JSON.stringify(result)]);
      }
      await refreshCampaignStatus(String(publication.campaign_id));
    } catch (error: any) {
      console.warn("[social-tiktok-status]", error?.message || error);
    }
  }
}

async function processDue() {
  if (queueBusy) return;
  queueBusy = true;
  try {
    await ensureSchema();
    const due = await db.query(`SELECT id FROM social_publications WHERE status='scheduled' AND COALESCE(scheduled_at,now())<=now() ORDER BY scheduled_at NULLS FIRST LIMIT 12`);
    for (const row of due.rows) await executePublication(String(row.id));
    await refreshTikTokSubmitted();
  } finally {
    queueBusy = false;
  }
}

const queueTimer = setInterval(() => { void processDue().catch(error => console.error("[social-queue]", error?.message || error)); }, 60_000);
(queueTimer as any).unref?.();

router.get("/overview", async (_req, res, next) => {
  try {
    const [campaigns, sources] = await Promise.all([
      db.query(`SELECT c.*,COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.platform) FILTER (WHERE p.id IS NOT NULL),'[]'::jsonb) publications FROM social_campaigns c LEFT JOIN social_publications p ON p.campaign_id=c.id GROUP BY c.id ORDER BY c.created_at DESC LIMIT 200`),
      sourceLists(),
    ]);
    res.json({ campaigns: campaigns.rows, sources, ...publicSocialAccountStatus() });
  } catch (error) { next(error); }
});

router.post("/generate-copy", async (req, res) => {
  res.json({ platform_payloads: generatedPayloads(req.body || {}) });
});

router.post("/accounts/verify", async (_req, res) => {
  res.json({ ...publicSocialAccountStatus(), verification: await verifySocialAccounts() });
});

router.post("/campaigns", async (req, res, next) => {
  const client = await db.connect();
  try {
    const body = req.body || {};
    const chosen = selectedPlatforms(body.platforms);
    if (!socialText(body.name, 240) || !socialText(body.headline, 300)) return res.status(400).json({ message: "A kampánynév és a főcím kötelező." });
    if (!chosen.length) return res.status(400).json({ message: "Válasszon legalább egy social csatornát." });
    const sourceType = ["manual", "daily_action", "job", "newsletter"].includes(socialText(body.source_type, 40)) ? socialText(body.source_type, 40) : "manual";
    const sourceId = isUuid(body.source_id) ? String(body.source_id) : null;
    const payloads = mergedPayloads(body);
    await client.query("BEGIN");
    const campaign = (await client.query(`INSERT INTO social_campaigns(source_type,source_id,name,headline,description,image_url,video_url,link_url,platform_payloads,scheduled_at,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,'draft',$11) RETURNING *`, [sourceType, sourceId, socialText(body.name, 240), socialText(body.headline, 300), socialText(body.description || body.description_html, 12000), socialText(body.image_url, 16000000) || null, socialText(body.video_url, 16000000) || null, socialText(body.link_url, 3000) || null, JSON.stringify(payloads), body.scheduled_at || null, socialText((req as any).user?.id || (req as any).user?.email, 200) || null])).rows[0];
    for (const platform of chosen) {
      await client.query(`INSERT INTO social_publications(campaign_id,platform,payload,status,scheduled_at) VALUES($1,$2,$3::jsonb,'draft',$4)`, [campaign.id, platform, JSON.stringify(payloads[platform]), body.scheduled_at || null]);
    }
    await client.query("COMMIT");
    res.status(201).json(await hydrateCampaign(String(campaign.id)));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

router.patch("/campaigns/:id", async (req, res, next) => {
  const client = await db.connect();
  try {
    const existing = (await client.query(`SELECT * FROM social_campaigns WHERE id=$1`, [req.params.id])).rows[0];
    if (!existing) return res.status(404).json({ message: "A social kampány nem található." });
    if (["processing", "published"].includes(String(existing.status))) return res.status(409).json({ message: "Folyamatban lévő vagy publikált kampány nem írható át. Készítsen új változatot." });
    const currentPlatforms = (await client.query(`SELECT platform FROM social_publications WHERE campaign_id=$1`, [existing.id])).rows.map(row => row.platform);
    const body = { ...existing, ...(req.body || {}) };
    const chosen = selectedPlatforms(req.body?.platforms || currentPlatforms);
    if (!chosen.length) return res.status(400).json({ message: "Válasszon legalább egy social csatornát." });
    const payloads = mergedPayloads(body);
    await client.query("BEGIN");
    await client.query(`UPDATE social_campaigns SET name=$2,headline=$3,description=$4,image_url=$5,video_url=$6,link_url=$7,platform_payloads=$8::jsonb,scheduled_at=$9,status='draft',updated_at=now() WHERE id=$1`, [existing.id, socialText(body.name, 240), socialText(body.headline, 300), socialText(body.description, 12000), socialText(body.image_url, 16000000) || null, socialText(body.video_url, 16000000) || null, socialText(body.link_url, 3000) || null, JSON.stringify(payloads), body.scheduled_at || null]);
    await client.query(`DELETE FROM social_publications WHERE campaign_id=$1 AND platform<>ALL($2::text[])`, [existing.id, chosen]);
    for (const platform of chosen) {
      await client.query(`INSERT INTO social_publications(campaign_id,platform,payload,status,scheduled_at) VALUES($1,$2,$3::jsonb,'draft',$4) ON CONFLICT(campaign_id,platform) DO UPDATE SET payload=EXCLUDED.payload,status='draft',scheduled_at=EXCLUDED.scheduled_at,error=NULL,updated_at=now()`, [existing.id, platform, JSON.stringify(payloads[platform]), body.scheduled_at || null]);
    }
    await client.query("COMMIT");
    res.json(await hydrateCampaign(String(existing.id)));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

router.post("/campaigns/:id/schedule", async (req, res, next) => {
  try {
    const when = new Date(req.body?.scheduled_at);
    if (Number.isNaN(when.getTime())) return res.status(400).json({ message: "Adjon meg érvényes publikálási időpontot." });
    const campaign = (await db.query(`UPDATE social_campaigns SET scheduled_at=$2,status='scheduled',updated_at=now() WHERE id=$1 AND status NOT IN ('published','processing') RETURNING *`, [req.params.id, when])).rows[0];
    if (!campaign) return res.status(404).json({ message: "A kampány nem található vagy már nem időzíthető." });
    await db.query(`UPDATE social_publications SET scheduled_at=$2,status='scheduled',error=NULL,updated_at=now() WHERE campaign_id=$1 AND status NOT IN ('published','submitted','processing')`, [campaign.id, when]);
    res.json(await hydrateCampaign(String(campaign.id)));
  } catch (error) { next(error); }
});

router.post("/campaigns/:id/publish", async (req, res, next) => {
  try {
    const campaign = (await db.query(`SELECT * FROM social_campaigns WHERE id=$1`, [req.params.id])).rows[0];
    if (!campaign) return res.status(404).json({ message: "A kampány nem található." });
    await db.query(`UPDATE social_publications SET status='scheduled',scheduled_at=now(),error=NULL,updated_at=now() WHERE campaign_id=$1 AND status NOT IN ('published','submitted','processing')`, [campaign.id]);
    await db.query(`UPDATE social_campaigns SET status='scheduled',scheduled_at=now(),updated_at=now() WHERE id=$1`, [campaign.id]);
    const ids = (await db.query(`SELECT id FROM social_publications WHERE campaign_id=$1 AND status='scheduled' ORDER BY platform`, [campaign.id])).rows;
    for (const row of ids) await executePublication(String(row.id));
    res.json(await hydrateCampaign(String(campaign.id)));
  } catch (error) { next(error); }
});

router.post("/publications/:id/retry", async (req, res, next) => {
  try {
    const row = (await db.query(`UPDATE social_publications SET status='scheduled',scheduled_at=now(),error=NULL,updated_at=now() WHERE id=$1 AND status='failed' RETURNING id,campaign_id`, [req.params.id])).rows[0];
    if (!row) return res.status(404).json({ message: "A sikertelen publikáció nem található." });
    await executePublication(String(row.id));
    res.json(await hydrateCampaign(String(row.campaign_id)));
  } catch (error) { next(error); }
});

router.post("/process-due", async (_req, res, next) => {
  try {
    await processDue();
    res.json({ ok: true, processed_at: new Date().toISOString() });
  } catch (error) { next(error); }
});

export default router;
