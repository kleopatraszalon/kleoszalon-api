// src/middleware/auth.ts
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { enforceKnownModuleAccess } from "./pathAccess";
import JWT_SECRET from "../security/jwtSecret";

export interface AuthRequest extends Request {
  user?: {
    id: number;
    email?: string;
    role?: string;
    location_id?: number | null;
  };
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

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const token = getTokenFromReq(req);

  if (!token) {
    return res.status(401).json({
      error: "Nincs belépés. Kérjük, jelentkezz be újra.",
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;

    req.user = {
      id: decoded.id ?? decoded.userId,
      email: decoded.email,
      role: decoded.role,
      location_id: decoded.location_id ?? null,
    };

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
