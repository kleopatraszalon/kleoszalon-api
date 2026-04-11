import { Router, Response } from "express";
import { AuthRequest, requireAuth } from "../middleware/auth";

const router = Router();

router.get("/", requireAuth, async (req: AuthRequest, res: Response) => {
  return res.json({
    ok: true,
    user: {
      id: req.user?.id ?? null,
      email: req.user?.email ?? null,
      role: req.user?.role ?? null,
      location_id: req.user?.location_id ?? null,
    },
  });
});

export default router;
