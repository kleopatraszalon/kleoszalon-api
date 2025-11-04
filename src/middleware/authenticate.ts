import jwt from "jsonwebtoken";
import { Request, Response, NextFunction } from "express";

export interface AuthUser {
  id: string;
  role: string;
  location_id: string | null;
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

export function authenticate(req: AuthRequest, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  if (!auth) {
    return res.status(401).json({ error: "Nincs token" });
  }

  try {
    const token = auth.split(" ")[1];
    const decoded: any = jwt.verify(token, process.env.JWT_SECRET as string);

    req.user = {
      id: decoded.userId,
      role: decoded.role || "guest",
      location_id: decoded.location_id || null,
    };

    next();
  } catch (err) {
    return res.status(403).json({ error: "Érvénytelen token" });
  }
}
