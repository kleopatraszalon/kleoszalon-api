// src/middleware/auth.ts
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface AuthRequest extends Request {
  user?: {
    id: number;
    email?: string;
    role?: string;
    location_id?: number | null;
  };
}

const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";

function getTokenFromReq(req: Request): string | null {
  const authHeader =
    (req.headers["authorization"] as string | undefined) ||
    (req.headers["Authorization"] as string | undefined);

  if (authHeader && /^Bearer\s+/i.test(authHeader)) {
    return authHeader.replace(/^Bearer\s+/i, "");
  }

  const cookieToken = (req as any).cookies?.token;
  if (cookieToken) return cookieToken;

  if (typeof req.query.token === "string") return req.query.token;
  if (req.body && typeof (req.body as any).token === "string") {
    return (req.body as any).token;
  }

  return null;
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const token = getTokenFromReq(req);

  if (!token) {
    return res.status(401).json({
      error: "Nincs belépés. Kérjük, jelentkezz be újra.",
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;

    req.user = {
      id: decoded.id,
      email: decoded.email,
      role: decoded.role,
      location_id: decoded.location_id ?? null,
    };

    return next();
  } catch (err: any) {
    console.error("JWT hiba:", err);

    // Lejárt token esetén: süti törlése + kulturált üzenet
    if (err.name === "TokenExpiredError") {
      res.clearCookie("token", { path: "/" });
      return res.status(401).json({
        error: "A munkamenet lejárt. Kérjük, jelentkezz be újra.",
      });
    }

    return res.status(401).json({
      error: "Érvénytelen token. Kérjük, jelentkezz be újra.",
    });
  }
}
