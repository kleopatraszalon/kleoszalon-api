import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface AuthRequest extends Request {
  user?: {
    id: string;
    role: string;
    location_id?: string | null;
  };
}

// csak belépett usernek engedjük (admin, recepciós, dolgozó, bárki aktív)
export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: "Hiányzó jogosultság (nincs token)" });
  }

  try {
    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as any;

    // elvárás: a login-nál így rakjuk össze majd a token payloadot:
    // { id, role, location_id }
    // Robusztusabb: elfogadjuk az id / userId / sub mezőt is
    const uid = decoded.id ?? decoded.userId ?? decoded.sub;

    req.user = {
      id: uid,
      role: decoded.role,
      location_id: decoded.location_id ?? null,
    };

    next();
  } catch (err) {
    console.error("JWT hiba:", err);
    return res.status(403).json({ error: "Érvénytelen token" });
  }
}

// akkor használd, ha csak bizonyos szerepkör mehet be
export function requireRole(allowedRoles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: "Nincs hitelesítés" });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: "Nincs jogosultság ehhez a művelethez" });
    }
    next();
  };
}
