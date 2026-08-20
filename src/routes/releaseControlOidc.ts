import { Router, type Request, type Response } from "express";
import axios from "axios";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { currentReleaseRef, recordReleaseComponent, recordReleaseEvidence } from "./releaseControl";

const router = Router();
const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const RELEASE_CONTROL_AUDIENCE = "kleoszalon-release-control";

type EvidenceScope = "backend" | "frontend" | "operational";
type WorkflowRule = { repository: string; workflow_ref: string; keys: Set<string>; scope: EvidenceScope };
const WORKFLOW_RULES: WorkflowRule[] = [
  {
    repository: "kleopatraszalon/kleoszalon-api",
    workflow_ref: "kleopatraszalon/kleoszalon-api/.github/workflows/render-deploy.yml@refs/heads/main",
    keys: new Set(["tests.backend", "build.backend", "tests.integration", "tests.financial", "tests.saas", "tests.rbac"]),
    scope: "backend",
  },
  {
    repository: "kleopatraszalon/kleoszalon-api",
    workflow_ref: "kleopatraszalon/kleoszalon-api/.github/workflows/backup-restore-evidence.yml@refs/heads/main",
    keys: new Set(["backup.restore"]),
    scope: "operational",
  },
  {
    repository: "kleopatraszalon/kleoszalon-frontend",
    workflow_ref: "kleopatraszalon/kleoszalon-frontend/.github/workflows/render-deploy.yml@refs/heads/main",
    keys: new Set(["version.frontend", "tests.frontend", "build.frontend"]),
    scope: "frontend",
  },
];

function bearerToken(req: Request): string {
  const authorization = String(req.headers.authorization || "").trim();
  return authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : "";
}

function validSha(value: unknown): string | null {
  const ref = String(value || "").trim();
  return /^[a-f0-9]{40}$/i.test(ref) ? ref.toLowerCase() : null;
}

async function verifyGitHubWorkflow(token: string) {
  const decoded = jwt.decode(token, { complete: true }) as any;
  const kid = String(decoded?.header?.kid || "");
  if (!kid) throw new Error("GitHub OIDC token kid hiányzik.");
  const jwks = await axios.get<{ keys: any[] }>(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`, {
    timeout: 10_000,
    headers: { Accept: "application/json" },
  });
  const jwk = (jwks.data?.keys || []).find((x: any) => String(x?.kid || "") === kid);
  if (!jwk) throw new Error("A GitHub OIDC aláírókulcs nem található.");
  const publicKey = crypto.createPublicKey({ key: jwk, format: "jwk" } as any);
  const claims = jwt.verify(token, publicKey, {
    algorithms: ["RS256"],
    issuer: GITHUB_OIDC_ISSUER,
    audience: RELEASE_CONTROL_AUDIENCE,
  }) as any;
  if (String(claims?.ref || "") !== "refs/heads/main") throw new Error("Release evidence csak main ágról fogadható.");
  const rule = WORKFLOW_RULES.find(
    x => x.repository === String(claims?.repository || "") && x.workflow_ref === String(claims?.workflow_ref || ""),
  );
  if (!rule) throw new Error("Nem engedélyezett GitHub release workflow.");
  return { claims, rule };
}

router.post("/evidence", async (req: Request, res: Response) => {
  const oidcToken = bearerToken(req);
  if (!oidcToken) return res.status(401).json({ error: "GitHub OIDC token szükséges." });
  try {
    const { claims, rule } = await verifyGitHubWorkflow(oidcToken);
    const currentBackendRef = currentReleaseRef();
    const expectedRef = String(req.body?.expected_release_ref || "").trim();

    if (rule.scope === "backend" && expectedRef && expectedRef !== currentBackendRef) {
      return res.status(409).json({
        error: "release_ref_mismatch",
        message: "A workflow commitja még nem azonos a futó backend release-szel.",
        expected_release_ref: expectedRef,
        current_release_ref: currentBackendRef,
      });
    }

    const entries = Array.isArray(req.body?.entries) ? req.body.entries.slice(0, 20) : [];
    if (!entries.length) return res.status(400).json({ error: "Legalább egy release evidence tétel szükséges." });

    const runUrl = `https://github.com/${claims.repository}/actions/runs/${String(claims?.run_id || "")}`;
    const updatedBy = `github-actions:${String(claims?.actor || "unknown")}`;
    const source = `github-actions:${String(claims?.workflow_ref || "workflow")}`.slice(0, 300);

    let evidenceRef = currentBackendRef;
    let componentRef: string | null = null;
    if (rule.scope === "frontend") {
      componentRef = validSha(claims?.sha || req.body?.component_ref);
      if (!componentRef) throw new Error("A frontend workflow hiteles commit SHA-ja hiányzik.");
      await recordReleaseComponent({
        component: "frontend",
        component_ref: componentRef,
        source,
        updated_by: updatedBy,
      });
      evidenceRef = `frontend:${componentRef}`;
    } else if (rule.scope === "operational") {
      evidenceRef = "operational:backup";
    }

    const saved = [];
    for (const entry of entries) {
      const key = String(entry?.key || "").trim();
      if (!rule.keys.has(key)) return res.status(403).json({ error: `A workflow nem írhatja ezt a release gate-et: ${key}` });
      const status = String(entry?.status || "pass").trim();
      if (!["pass", "warning", "fail", "pending"].includes(status)) return res.status(400).json({ error: `Érvénytelen release gate státusz: ${status}` });
      const detail = String(entry?.evidence || "").trim();
      const evidence = [detail, componentRef ? `Component SHA: ${componentRef}` : "", `Run: ${runUrl}`].filter(Boolean).join(" · ").slice(0, 4000);
      saved.push(await recordReleaseEvidence({
        release_ref: evidenceRef,
        key,
        status: status as "pass" | "warning" | "fail" | "pending",
        evidence,
        source,
        updated_by: updatedBy,
      }));
    }
    console.info("[RELEASE-CONTROL] GitHub evidence accepted", {
      repository: String(claims?.repository || ""),
      workflow_ref: String(claims?.workflow_ref || ""),
      run_id: String(claims?.run_id || ""),
      scope: rule.scope,
      backend_release_ref: currentBackendRef,
      evidence_ref: evidenceRef,
      component_ref: componentRef,
      keys: saved.map((x: any) => x.check_key),
    });
    return res.json({ ok: true, release_ref: evidenceRef, backend_release_ref: currentBackendRef, component_ref: componentRef, saved });
  } catch (error: any) {
    console.warn("[RELEASE-CONTROL] GitHub OIDC evidence rejected:", error?.message || String(error));
    return res.status(401).json({ error: "Érvénytelen vagy nem engedélyezett GitHub release workflow." });
  }
});

export default router;
