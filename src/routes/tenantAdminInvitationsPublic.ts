import { Request, Response, Router } from "express";
import db from "../db";
import { acceptTenantAdminInvitation, validateTenantAdminInvitation } from "../services/tenantAdminInvitations";
import { activateSelfServiceTrial } from "../services/saasSelfService";

const router = Router();

router.get("/:token", async (req: Request, res: Response) => {
  const token = String(req.params.token || "").trim();
  if (token.length < 20) return res.status(400).json({ ok:false, code:"INVALID_INVITE_TOKEN", error:"Érvénytelen meghívó token." });
  try {
    const result = await validateTenantAdminInvitation(token);
    res.setHeader("Cache-Control", "no-store");
    if (!result.valid) {
      const status = result.code === "INVITE_NOT_FOUND" ? 404 : 410;
      return res.status(status).json({ ok:false, code:result.code, error:result.code === "INVITE_EXPIRED" ? "A meghívó lejárt." : result.code === "INVITE_ALREADY_USED" ? "A meghívót már felhasználták vagy visszavonták." : "A meghívó nem található." });
    }
    return res.json({ ok:true, invitation:{ email:result.invitation.email, tenant_name:result.invitation.tenant_name, tenant_slug:result.invitation.tenant_slug, expires_at:result.invitation.expires_at } });
  } catch (error) {
    console.error("[TENANT ADMIN INVITE] validate:", error);
    return res.status(500).json({ ok:false, error:"A meghívó ellenőrzése nem sikerült." });
  }
});

router.post("/:token/accept", async (req: Request, res: Response) => {
  const token = String(req.params.token || "").trim();
  if (token.length < 20) return res.status(400).json({ ok:false, code:"INVALID_INVITE_TOKEN", error:"Érvénytelen meghívó token." });
  try {
    const result = await acceptTenantAdminInvitation({ token, fullName:String(req.body?.full_name || ""), password:String(req.body?.password || "") });
    res.setHeader("Cache-Control", "no-store");
    if (!result.ok) {
      const status = result.code === "INVITE_NOT_FOUND" ? 404 : 410;
      return res.status(status).json({ ok:false, code:result.code, error:result.code === "INVITE_EXPIRED" ? "A meghívó lejárt; kérjen új meghívót." : result.code === "INVITE_ALREADY_USED" ? "A meghívó már nem használható." : "A meghívó nem található." });
    }
    let trialStarted=false;
    const client=await db.connect();
    try{await client.query("BEGIN");trialStarted=await activateSelfServiceTrial(client,String(result.tenant_id),String(result.user_id||""));await client.query("COMMIT");}
    catch(error){await client.query("ROLLBACK").catch(()=>undefined);console.error("[TENANT ADMIN INVITE] self-service trial activation:",error);throw error;}
    finally{client.release();}
    return res.status(201).json({ ok:true, tenant_id:result.tenant_id, tenant_name:result.tenant_name, email:result.email, trial_started:trialStarted, message:trialStarted?"Az adminisztrátori fiók aktiválása sikerült, a 14 napos próbaidő elindult. Most már bejelentkezhet.":"Az adminisztrátori fiók aktiválása sikerült. Most már bejelentkezhet." });
  } catch (error:any) {
    if (["INVALID_ADMIN_NAME","WEAK_ADMIN_PASSWORD"].includes(String(error?.code || ""))) return res.status(400).json({ ok:false, code:error.code, error:error.message });
    if (String(error?.code || "") === "23505") return res.status(409).json({ ok:false, code:"ADMIN_ACCOUNT_CONFLICT", error:"Ezzel az e-mail címmel vagy felhasználónévvel már létezik fiók." });
    console.error("[TENANT ADMIN INVITE] accept:", error);
    return res.status(500).json({ ok:false, error:"Az adminisztrátori fiók aktiválása nem sikerült." });
  }
});

export default router;
