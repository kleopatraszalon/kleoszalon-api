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
    uat_scope?: string;
  };
}

type CredentialSource = "bearer" | "cookie";
type RequestCredential = { token: string; source: CredentialSource };
const COOKIE_SESSION_MARKERS = new Set(["cookie-session", "cookie-session-v1"]);

/**
 * Authentication tokens are accepted only from transport locations that are
 * intended for credentials: the Authorization header or the HttpOnly cookie.
 * Query-string/body tokens are deliberately rejected because URLs and request
 * bodies can be copied into browser history, proxy/access logs and diagnostics.
 */
function getCredentialFromReq(req: Request): RequestCredential | null {
  const authHeader =
    (req.headers["authorization"] as string | undefined) ||
    (req.headers["Authorization"] as string | undefined);

  let bearer = "";
  if (authHeader && /^Bearer\s+/i.test(authHeader)) {
    bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (bearer && !COOKIE_SESSION_MARKERS.has(bearer)) {
      return { token: bearer, source: "bearer" };
    }
  }

  const cookieToken = (req as any).cookies?.token;
  if (typeof cookieToken === "string" && cookieToken.trim()) {
    return { token: cookieToken.trim(), source: "cookie" };
  }

  return null;
}

function normalizeOrigin(value: string) {
  return String(value || "").trim().replace(/\/$/, "");
}

const DEFAULT_TRUSTED_BROWSER_ORIGINS = [
  "https://kleoszalon-frontend.onrender.com",
  "https://weblap-o3g6.onrender.com",
  "https://kleoszalon-api-1.onrender.com",
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:3001",
  "http://127.0.0.1:5173",
].map(normalizeOrigin);

function trustedBrowserOrigins() {
  const configured = String(process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);
  return new Set([...DEFAULT_TRUSTED_BROWSER_ORIGINS, ...configured]);
}

function isUnsafeMethod(method: string) {
  return !["GET", "HEAD", "OPTIONS"].includes(String(method || "").toUpperCase());
}

/**
 * Cookie authentication is an ambient browser credential, therefore unsafe
 * requests must be demonstrably same-site/trusted-origin. Bearer/OIDC clients
 * are not subject to CSRF because the browser does not attach those credentials
 * automatically.
 */
function cookieRequestPassesCsrfBoundary(req: Request) {
  if (!isUnsafeMethod(req.method)) return true;

  const fetchSite = String(req.headers["sec-fetch-site"] || "").toLowerCase();
  if (fetchSite === "cross-site") return false;

  const origin = normalizeOrigin(String(req.headers.origin || ""));
  if (origin === "null") return false;
  if (origin && !trustedBrowserOrigins().has(origin)) return false;

  return true;
}

function navTestUatPathAllowed(req:Request){
  const path=String(req.originalUrl||req.url||"").split("?")[0];
  return path.startsWith("/api/transactions/nav-test-uat/")||path==="/api/transactions/nav-test-uat"||
         path.startsWith("/api/transactions/nav-online-invoice/")||path==="/api/transactions/nav-online-invoice";
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const credential = getCredentialFromReq(req);

  if (!credential) {
    return res.status(401).json({
      error: "Nincs belépés. Kérjük, jelentkezz be újra.",
    });
  }

  if (credential.source === "cookie" && !cookieRequestPassesCsrfBoundary(req)) {
    return res.status(403).json({
      code: "CSRF_ORIGIN_REJECTED",
      error: "A kérés biztonsági eredetellenőrzése sikertelen.",
    });
  }

  try {
    const decoded = jwt.verify(credential.token, JWT_SECRET) as any;

    req.user = {
      id: decoded.id ?? decoded.userId,
      email: decoded.email,
      role: decoded.role,
      location_id: decoded.location_id ?? null,
      tenant_id: decoded.tenant_id ?? null,
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
