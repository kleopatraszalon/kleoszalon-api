import { Request } from "express";

export interface AuthUser {
  id: string;
  role: string;
  location_id?: string | null;
}

export interface AuthenticatedRequest extends Request {
  user: AuthUser;
}
