// src/middleware/auth.ts
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { enforceKnownModuleAccess } from "./pathAccess";
import JWT_SECRET from "../security/jwtSecret";

export interface AuthRequest extends Request {
  user?: {
    id: number | string;
    email?: string;
    role?: string | string[];
    location_id?: number | string | null;
    tenant_id?: number | string | null;
    employee_id?: number | string | null;
    uat_scope?: string;
  };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const DEFAULT_BROWSER_ORIGINS = [
  "https://kleoszalon-frontend.onrender.com",
  "https://weblap-o3g6.onrender.com",
  "https://kleoszalon-api-1.onrender.com",
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:3001",
  "http://127.0.0.1:5173",
];

function normalizeOrigin(value: unknown): string {
  return String(value ?? "").trim().replace(/^["']|["']$/g, "").replace(/\/$/, "");
}

function trustedBrowserOrigins(): Set<string> {
  const configured = String(process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);
  return new Set([...DEFAULT_BROWSER_ORIGINS.map(normalizeOrigin), ...configured]);
}

function bearerHeader(req: Request): string {
  const value = String(req.headers.authorization ?? "").trim();
  return /^Bearer\s+/i.test(value) ? value : "";
}

/**
 * CSRF applies only when the browser authenticates through the HttpOnly cookie.
 * Explicit Bearer clients are not ambient-authority requests and remain usable
 * for GitHub UAT and other non-browser integrations.
 */
export function browserCookieMutationAllowed(req: Request): boolean {
  if (SAFE_METHODS.has(String(req.method || "GET").toUpperCase())) return true;
  if (bearerHeader(req)) return true;

  const cookieToken = (req as any).cookies?.token;
  if (typeof cookieToken !== "string" || !cookieToken.trim()) return true;

  const fetchSite = String(req.headers["sec-fetch-site"] ?? "").trim().toLowerCase();
  if (fetchSite === "cross-site") return false;

  const origin = normalizeOrigin(req.headers.origin);
  if (origin) return trustedBrowserOrigins().has(origin);

  // Modern same-origin browser requests expose Sec-Fetch-Site. Requests with an
  // ambient auth cookie but no verifiable browser origin fail closed.
  return fetchSite === "same-origin";
}

/**
 * Authentication tokens are accepted only from transport locations that are
 * intended for credentials: the Authorization header or the HttpOnly cookie.
 * Query-string/body tokens are deliberately rejected because URLs and request
 * bodies can be copied into browser history, proxy/access logs and diagnostics.
 */
function getTokenFromReq(req: Request): string | null {
  const authHeader =
    (req.headers["authorization"] as string | undefined) ||
    (req.headers["Authorization"] as string | undefined);

  if (authHeader && /^Bearer\s+/i.test(authHeader)) {
    return authHeader.replace(/^Bearer\s+/i, "").trim() || null;
  }

  const cookieToken = (req as any).cookies?.token;
  if (typeof cookieToken === "string" && cookieToken.trim()) {
    return cookieToken.trim();
  }

  return null;
}

function navTestUatPathAllowed(req:Request){
  const path=String(req.originalUrl||req.url||"").split("?")[0];
  return path.startsWith("/api/transactions/nav-test-uat/")||path==="/api/transactions/nav-test-uat"||
         path.startsWith("/api/transactions/nav-online-invoice/")||path==="/api/transactions/nav-online-invoice";
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const token = getTokenFromReq(req);

  if (!token) {
    return res.status(401).json({
      error: "Nincs belépés. Kérjük, jelentkezz be újra.",
    });
  }

  if (!browserCookieMutationAllowed(req)) {
    return res.status(403).json({
      error: "A böngészős kérés eredete nem engedélyezett.",
      code: "CSRF_ORIGIN_REJECTED",
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    const decodedId = decoded.id ?? decoded.userId;
    const previousUser = req.user;
    const sameAuthenticatedUser = previousUser?.id != null && decodedId != null && String(previousUser.id) === String(decodedId);

    // Scoped middleware can enrich req.user with a tenant resolved and validated
    // against the database before an inner router applies requireAuth again. When
    // the same verified user is authenticated twice in one request, that trusted
    // in-request tenant/location context is more current than a legacy or stale JWT.
    const preservedTenantId = sameAuthenticatedUser ? previousUser?.tenant_id ?? null : null;
    const preservedLocationId = sameAuthenticatedUser ? previousUser?.location_id ?? null : null;
    const preservedEmployeeId = sameAuthenticatedUser ? previousUser?.employee_id ?? null : null;

    req.user = {
      id: decodedId,
      email: decoded.email,
      role: decoded.role,
      location_id: preservedLocationId ?? decoded.location_id ?? null,
      tenant_id: preservedTenantId ?? decoded.tenant_id ?? null,
      employee_id: preservedEmployeeId ?? decoded.employee_id ?? null,
      uat_scope: decoded.uat_scope ? String(decoded.uat_scope) : undefined,
    };

    if(req.user.uat_scope==="nav_test"&&!navTestUatPathAllowed(req)){
      return res.status(403).json({
        error:"A NAV TEST UAT token kizárólag a NAV teszt végpontokra használható.",
        uat_scope:"nav_test"
      });
    }

    const allowed = await enforceKnownModuleAccess(req, res);
    if (!allowed) return;
    return next();
  } catch (err: any) {
    console.error("JWT / jogosultsági hiba:", err);

    if (err.name === "TokenExpiredError") {
      res.clearCookie("token", { path: "/" });
      return res.status(401).json({
        error: "A munkamenet lejárt. Kérjük, jelentkezz be újra.",
      });
    }

    if (["JsonWebTokenError", "NotBeforeError"].includes(String(err?.name || ""))) {
      return res.status(401).json({
        error: "Érvénytelen token. Kérjük, jelentkezz be újra.",
      });
    }

    return next(err);
  }
}
