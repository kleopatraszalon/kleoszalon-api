import { getRuntimeSecret, getRuntimeValue } from "./virRuntimeSettings";

export type RenderInfrastructureStatus = {
  configured: boolean;
  service_id: string | null;
  postgres_id: string | null;
  instance_count: number | null;
  target_instances: number;
  database_ha_enabled: boolean | null;
  ready_for_single_instance_failure: boolean;
  error?: string;
};

async function bodyOf(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

async function externalJson(url: string, init: RequestInit, service: string): Promise<any> {
  const response = await fetch(url, init);
  const body = await bodyOf(response);
  if (!response.ok) {
    const detail = typeof body === "string" ? body : body?.message || body?.error || JSON.stringify(body || {});
    const error: any = new Error(`${service} API ${response.status}: ${detail}`.slice(0, 1200));
    error.status = response.status >= 400 && response.status < 500 ? 400 : 502;
    error.code = `${service.toUpperCase()}_API_ERROR`;
    throw error;
  }
  return body;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2026-03-10",
    "Content-Type": "application/json",
    "User-Agent": "Kleoszalon-VIR",
  };
}

export async function applyGitHubReleaseEnvironment(): Promise<any> {
  const token = await getRuntimeSecret("VIR_GITHUB_TOKEN");
  const owner = (await getRuntimeValue("VIR_GITHUB_OWNER")) || "kleopatraszalon";
  const repos = ((await getRuntimeValue("VIR_GITHUB_REPOS")) || "kleoszalon-api,kleoszalon-frontend").split(",").map(x => x.trim()).filter(Boolean);
  const environment = (await getRuntimeValue("VIR_GITHUB_ENVIRONMENT")) || "production-manual-approval";
  const reviewer = (await getRuntimeValue("VIR_GITHUB_REVIEWER")) || owner;
  const preventSelfReview = ((await getRuntimeValue("VIR_GITHUB_PREVENT_SELF_REVIEW")) || "0") === "1";
  if (!token) throw Object.assign(new Error("A GitHub admin token nincs beállítva a VIR-ben."), { status: 400, code: "GITHUB_TOKEN_MISSING" });
  if (!repos.length) throw Object.assign(new Error("Legalább egy GitHub repository szükséges."), { status: 400, code: "GITHUB_REPO_MISSING" });

  const user = await externalJson(`https://api.github.com/users/${encodeURIComponent(reviewer)}`, { headers: githubHeaders(token) }, "github");
  if (!user?.id) throw Object.assign(new Error("A beállított GitHub reviewer nem található."), { status: 400, code: "GITHUB_REVIEWER_INVALID" });

  const results: any[] = [];
  for (const repo of repos) {
    const result = await externalJson(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/environments/${encodeURIComponent(environment)}`,
      {
        method: "PUT",
        headers: githubHeaders(token),
        body: JSON.stringify({
          wait_timer: 0,
          prevent_self_review: preventSelfReview,
          reviewers: [{ type: "User", id: Number(user.id) }],
          deployment_branch_policy: null,
        }),
      },
      "github",
    );
    results.push({ repo, environment: result?.name || environment, reviewer, protection_rules: result?.protection_rules || [] });
  }
  return { ok: true, owner, reviewer, environment, repositories: results };
}

const FRONTEND_MAIN_REQUIRED_CHECKS = [
  "Frontend strict quality / build",
  "test-build-security",
  "verify",
  "build",
  "vite-shadow-build",
] as const;

export async function applyFrontendMainBranchProtection(): Promise<any> {
  const token = await getRuntimeSecret("VIR_GITHUB_TOKEN");
  const owner = (await getRuntimeValue("VIR_GITHUB_OWNER")) || "kleopatraszalon";
  const repo = "kleoszalon-frontend";
  const branch = "main";
  if (!token) throw Object.assign(new Error("A GitHub admin token nincs beállítva a VIR-ben."), { status: 400, code: "GITHUB_TOKEN_MISSING" });

  await externalJson(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${repo}/branches/${branch}/protection`,
    {
      method: "PUT",
      headers: githubHeaders(token),
      body: JSON.stringify({
        required_status_checks: { strict: true, contexts: [...FRONTEND_MAIN_REQUIRED_CHECKS] },
        enforce_admins: true,
        required_pull_request_reviews: {
          dismiss_stale_reviews: false,
          require_code_owner_reviews: false,
          required_approving_review_count: 0,
          require_last_push_approval: false,
        },
        restrictions: null,
        required_linear_history: false,
        allow_force_pushes: false,
        allow_deletions: false,
        block_creations: false,
        required_conversation_resolution: false,
        lock_branch: false,
        allow_fork_syncing: false,
      }),
    },
    "github",
  );

  const current = await externalJson(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${repo}/branches/${branch}`,
    { headers: githubHeaders(token) },
    "github",
  );
  if (current?.protected !== true) throw Object.assign(new Error("A frontend main branch protection visszaellenőrzése sikertelen."), { status: 502, code: "BRANCH_PROTECTION_VERIFY_FAILED" });

  return {
    ok: true,
    repository: `${owner}/${repo}`,
    branch,
    protected: true,
    enforce_admins: true,
    require_pull_request: true,
    required_approving_review_count: 0,
    required_status_checks: [...FRONTEND_MAIN_REQUIRED_CHECKS],
    strict_status_checks: true,
    allow_force_pushes: false,
    allow_deletions: false,
  };
}

function renderHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" };
}

function detectDbHa(pg: any): boolean | null {
  const values = [pg?.enableHighAvailability, pg?.highAvailabilityEnabled, pg?.highAvailability, pg?.haEnabled, pg?.database?.enableHighAvailability];
  const found = values.find(v => typeof v === "boolean");
  return typeof found === "boolean" ? found : null;
}

export async function getRenderInfrastructureStatus(): Promise<RenderInfrastructureStatus> {
  const token = await getRuntimeSecret("VIR_RENDER_API_KEY");
  const serviceId = await getRuntimeValue("VIR_RENDER_SERVICE_ID");
  const postgresId = await getRuntimeValue("VIR_RENDER_POSTGRES_ID");
  const targetInstances = Math.max(2, Math.min(20, Number((await getRuntimeValue("VIR_RENDER_TARGET_INSTANCES")) || 2)));
  if (!token || !serviceId || !postgresId) {
    return { configured: false, service_id: serviceId || null, postgres_id: postgresId || null, instance_count: null, target_instances: targetInstances, database_ha_enabled: null, ready_for_single_instance_failure: false };
  }
  try {
    const [instancesRaw, pg] = await Promise.all([
      externalJson(`https://api.render.com/v1/services/${encodeURIComponent(serviceId)}/instances`, { headers: renderHeaders(token) }, "render"),
      externalJson(`https://api.render.com/v1/postgres/${encodeURIComponent(postgresId)}`, { headers: renderHeaders(token) }, "render"),
    ]);
    const instances = Array.isArray(instancesRaw) ? instancesRaw : Array.isArray(instancesRaw?.instances) ? instancesRaw.instances : [];
    const instanceCount = instances.length;
    const dbHa = detectDbHa(pg);
    return {
      configured: true,
      service_id: serviceId,
      postgres_id: postgresId,
      instance_count: instanceCount,
      target_instances: targetInstances,
      database_ha_enabled: dbHa,
      ready_for_single_instance_failure: instanceCount >= 2 && dbHa === true,
    };
  } catch (error: any) {
    return { configured: true, service_id: serviceId, postgres_id: postgresId, instance_count: null, target_instances: targetInstances, database_ha_enabled: null, ready_for_single_instance_failure: false, error: error?.message || String(error) };
  }
}

export async function applyRenderHighAvailability(): Promise<any> {
  const token = await getRuntimeSecret("VIR_RENDER_API_KEY");
  const serviceId = await getRuntimeValue("VIR_RENDER_SERVICE_ID");
  const postgresId = await getRuntimeValue("VIR_RENDER_POSTGRES_ID");
  const targetInstances = Math.max(2, Math.min(20, Number((await getRuntimeValue("VIR_RENDER_TARGET_INSTANCES")) || 2)));
  const enableDbHa = ((await getRuntimeValue("VIR_RENDER_ENABLE_DB_HA")) || "1") !== "0";
  if (!token || !serviceId || !postgresId) throw Object.assign(new Error("A Render API key, service ID és Postgres ID beállítása kötelező."), { status: 400, code: "RENDER_CONFIG_MISSING" });

  await externalJson(
    `https://api.render.com/v1/services/${encodeURIComponent(serviceId)}/scale`,
    { method: "POST", headers: renderHeaders(token), body: JSON.stringify({ numInstances: targetInstances }) },
    "render",
  );
  process.env.RENDER_INSTANCE_COUNT = String(targetInstances);

  if (enableDbHa) {
    await externalJson(
      `https://api.render.com/v1/postgres/${encodeURIComponent(postgresId)}`,
      { method: "PATCH", headers: renderHeaders(token), body: JSON.stringify({ enableHighAvailability: true }) },
      "render",
    );
    process.env.DATABASE_HA_ENABLED = "1";
  }

  const status = await getRenderInfrastructureStatus();
  return { ok: true, applied: { target_instances: targetInstances, enable_database_ha: enableDbHa }, status };
}
