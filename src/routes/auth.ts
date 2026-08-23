// src/routes/auth.ts

import express, { Request, Response } from "express";
import db from "../db";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import axios from "axios";
import crypto from "crypto";
import JWT_SECRET from "../security/jwtSecret";
import { ensureAccountingUser } from "../accounting/ensureAccountingUser";
import releaseControlOidcRouter from "./releaseControlOidc";

const router = express.Router();
const GITHUB_OIDC_ISSUER="https://token.actions.githubusercontent.com";
const GITHUB_UAT_REPOSITORY="kleopatraszalon/kleoszalon-api";
async function verifyPassword(password:string,hash:string){
  if(!hash.startsWith("pbkdf2$"))return bcrypt.compare(password,hash);
  const[,roundsRaw,salt,expectedHex]=hash.split("$");const rounds=Number(roundsRaw);
  if(!Number.isInteger(rounds)||rounds<100000||!salt||!expectedHex)return false;
  const actual=crypto.pbkdf2Sync(password,salt,rounds,expectedHex.length/2,"sha256");
  const expected=Buffer.from(expectedHex,"hex");
  return actual.length===expected.length&&crypto.timingSafeEqual(actual,expected);
}
const ACCOUNTING_UAT_AUDIENCE="kleoszalon-accounting-uat";
const ACCOUNTING_UAT_WORKFLOW="kleopatraszalon/kleoszalon-api/.github/workflows/accounting-authenticated-uat.yml@refs/heads/main";
const NAV_TEST_UAT_AUDIENCE="kleoszalon-nav-test-uat";
const NAV_TEST_UAT_WORKFLOW="kleopatraszalon/kleoszalon-api/.github/workflows/nav-real-test-uat.yml@refs/heads/main";

function authCookieOptions() {
  const production = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    // Frontend and API are separate Render sites. SameSite=None is required,
    // while Partitioned (CHIPS) keeps the session usable when Chromium blocks
    // unpartitioned third-party cookies. CSRF remains enforced by auth middleware.
    sameSite: (production ? "none" : "lax") as "none" | "lax",
    secure: production,
    partitioned: production,
    path: "/",
  } as any;
}

function setAuthCookie(res: Response, token: string) {
  res.cookie("token", token, {
    ...authCookieOptions(),
    maxAge: 8 * 60 * 60 * 1000,
  });
  res.setHeader("Cache-Control", "no-store");
}

function clearAuthCookie(res: Response) {
  res.clearCookie("token", authCookieOptions());
}

function bearerToken(req: Request): string {
  const authorization=String(req.headers.authorization||"").trim();
  return authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : "";
}

function roleKeys(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).map(x => x.trim().toLowerCase()).filter(Boolean);
  const value = String(raw ?? "").trim();
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String).map(x => x.trim().toLowerCase()).filter(Boolean);
    if (parsed != null) return [String(parsed).trim().toLowerCase()].filter(Boolean);
  } catch {}
  return value
    .split(",")
    .map(x => x.split("[").join("").split("]").join("").trim().toLowerCase())
    .filter(Boolean);
}

function isAdminRole(raw: unknown) {
  return roleKeys(raw).some(r => ["admin", "administrator", "rendszergazda", "superadmin", "super_admin"].includes(r));
}

function isStaffRole(raw: unknown) {
  return roleKeys(raw).some(r => ["employee", "receptionist", "manager", "vezető", "vezeto"].includes(r));
}

function requestedLocation(req: Request): string | null {
  const value = String(req.body?.location_id ?? req.body?.selected_location_id ?? "").trim();
  return value || null;
}

async function findUser(identifier: string) {
  try {
    const { rows } = await db.query(
      `SELECT * FROM users
        WHERE lower(COALESCE(email,''))=lower($1)
           OR lower(COALESCE(login_name,''))=lower($1)
        LIMIT 1`,
      [identifier]
    );
    return rows[0] ?? null;
  } catch {
    const { rows } = await db.query(
      `SELECT * FROM users WHERE lower(COALESCE(email,''))=lower($1) LIMIT 1`,
      [identifier]
    );
    return rows[0] ?? null;
  }
}

async function findEmployee(identifier: string, user?: any) {
  const email = String(user?.email || "").trim();
  const loginName = String(user?.login_name || "").trim();
  const { rows } = await db.query(
    `SELECT e.id,e.full_name,e.email,e.login_name,e.password_hash,e.role,e.location_id,
            l.name AS location_name
       FROM employees e
       LEFT JOIN locations l ON l.id=e.location_id
      WHERE COALESCE(e.active,true)=true
        AND (
          lower(COALESCE(e.login_name,''))=lower($1)
          OR lower(COALESCE(e.email,''))=lower($1)
          OR ($2<>'' AND lower(COALESCE(e.email,''))=lower($2))
          OR ($3<>'' AND lower(COALESCE(e.login_name,''))=lower($3))
        )
      ORDER BY CASE WHEN lower(COALESCE(e.login_name,''))=lower($1) THEN 0 ELSE 1 END
      LIMIT 1`,
    [identifier,email,loginName]
  );
  return rows[0] ?? null;
}

async function locationName(locationId: any) {
  if (!locationId) return null;
  try {
    const { rows } = await db.query("SELECT name FROM locations WHERE id=$1 LIMIT 1", [locationId]);
    return rows[0]?.name ?? null;
  } catch {
    return null;
  }
}

async function respondAsEmployee(res: Response, employee: any, password: string, roleOverride?: any, requestedLocationId?: string | null) {
  if (!employee.password_hash) {
    return res.status(401).json({ error: "Ehhez a munkatárshoz még nincs jelszó beállítva." });
  }
  const ok = await verifyPassword(password, employee.password_hash);
  if (!ok) return res.status(401).json({ error: "Hibás felhasználó vagy jelszó." });
  if (!employee.location_id) {
    return res.status(409).json({ error: "A munkatárshoz nincs telephely rendelve. Kérlek jelezd az adminisztrátornak." });
  }
  if (requestedLocationId && String(employee.location_id) !== requestedLocationId) {
    return res.status(403).json({ error: "Ehhez a telephelyhez nincs jogosultságod." });
  }

  const role = roleOverride ?? employee.role ?? ["employee"];
  const token = jwt.sign(
    {
      id: employee.id,
      userId: employee.id,
      employee_id: employee.id,
      email: employee.email || employee.login_name,
      login_name: employee.login_name,
      role,
      location_id: employee.location_id,
    },
    JWT_SECRET,
    { expiresIn: "8h" }
  );

  setAuthCookie(res, token);
  return res.json({
    success: true,
    account_type: "staff",
    // Transitional compatibility only. Removed after the cookie-only frontend is deployed.
    token,
    role,
    location_id: employee.location_id,
    location_name: employee.location_name ?? null,
    full_name: employee.full_name ?? employee.login_name,
    email: employee.email ?? null,
    employee_id: employee.id,
    login_name: employee.login_name,
  });
}

async function verifyGitHubUatToken(token:string,audience:string,workflowRef:string){
  const decoded=jwt.decode(token,{complete:true}) as any;
  const kid=String(decoded?.header?.kid||"");
  if(!kid)throw new Error("GitHub OIDC token kid hiányzik.");
  const jwks=await axios.get<{keys:any[]}>(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`,{timeout:10_000,headers:{Accept:"application/json"}});
  const jwk=(jwks.data?.keys||[]).find((x:any)=>String(x?.kid||"")===kid);
  if(!jwk)throw new Error("A GitHub OIDC aláírókulcs nem található.");
  const publicKey=crypto.createPublicKey({key:jwk,format:"jwk"} as any);
  const claims=jwt.verify(token,publicKey,{algorithms:["RS256"],issuer:GITHUB_OIDC_ISSUER,audience}) as any;
  if(String(claims?.repository||"")!==GITHUB_UAT_REPOSITORY)throw new Error("Nem engedélyezett GitHub repository.");
  if(String(claims?.ref||"")!=="refs/heads/main")throw new Error("A production UAT kizárólag main ágról futtatható.");
  if(String(claims?.workflow_ref||"")!==workflowRef)throw new Error("Nem engedélyezett GitHub workflow.");
  return claims;
}

router.use("/uat/release-control", releaseControlOidcRouter);

router.post("/uat/accounting-token",async(req:Request,res:Response)=>{
  const oidcToken=bearerToken(req);
  if(!oidcToken)return res.status(401).json({error:"GitHub OIDC token szükséges."});
  try{
    const claims=await verifyGitHubUatToken(oidcToken,ACCOUNTING_UAT_AUDIENCE,ACCOUNTING_UAT_WORKFLOW);
    await ensureAccountingUser();
    const {rows}=await db.query(`SELECT id,email,login_name,role,location_id FROM users WHERE lower(COALESCE(email,''))='konyveles@kleoszalon.hu' OR lower(COALESCE(login_name,''))='könyvelés' ORDER BY CASE WHEN lower(COALESCE(email,''))='konyveles@kleoszalon.hu' THEN 0 ELSE 1 END LIMIT 1`);
    const user=rows[0];
    if(!user||!roleKeys(user.role).includes("accounting"))return res.status(409).json({error:"Az accounting UAT felhasználó nem áll rendelkezésre megfelelő szerepkörrel."});
    const token=jwt.sign({id:user.id,userId:user.id,email:user.email,role:user.role,location_id:null,uat:true,uat_source:"github-actions",uat_scope:"accounting"},JWT_SECRET,{expiresIn:"10m"});
    console.info("[ACCOUNTING-UAT] short-lived token issued",{run_id:String(claims?.run_id||""),actor:String(claims?.actor||""),repository:String(claims?.repository||"")});
    return res.json({success:true,token,expires_in_seconds:600,role:user.role,location_id:null});
  }catch(error:any){
    console.warn("[ACCOUNTING-UAT] OIDC bootstrap rejected:",error?.message||String(error));
    return res.status(401).json({error:"Érvénytelen vagy nem engedélyezett GitHub UAT identitás."});
  }
});

router.post("/uat/nav-test-token",async(req:Request,res:Response)=>{
  const oidcToken=bearerToken(req);
  if(!oidcToken)return res.status(401).json({error:"GitHub OIDC token szükséges."});
  try{
    const claims=await verifyGitHubUatToken(oidcToken,NAV_TEST_UAT_AUDIENCE,NAV_TEST_UAT_WORKFLOW);
    const token=jwt.sign({id:"github-nav-test-uat",userId:"github-nav-test-uat",email:"nav-test-uat@kleoszalon.hu",role:["admin"],location_id:null,uat:true,uat_source:"github-actions",uat_scope:"nav_test"},JWT_SECRET,{expiresIn:"10m"});
    console.info("[NAV-TEST-UAT] short-lived token issued",{run_id:String(claims?.run_id||""),actor:String(claims?.actor||""),repository:String(claims?.repository||"")});
    return res.json({success:true,token,expires_in_seconds:600,role:["admin"],location_id:null,uat_scope:"nav_test"});
  }catch(error:any){
    console.warn("[NAV-TEST-UAT] OIDC bootstrap rejected:",error?.message||String(error));
    return res.status(401).json({error:"Érvénytelen vagy nem engedélyezett GitHub NAV TEST UAT identitás."});
  }
});

/**
 * Exact GitHub NAV TEST workflow-only readiness check. Returns booleans only;
 * secret values are never serialized or logged.
 */
router.post("/uat/nav-test-readiness",async(req:Request,res:Response)=>{
  const oidcToken=bearerToken(req);
  if(!oidcToken)return res.status(401).json({error:"GitHub OIDC token szükséges."});
  try{
    const claims=await verifyGitHubUatToken(oidcToken,NAV_TEST_UAT_AUDIENCE,NAV_TEST_UAT_WORKFLOW);
    const credentials={
      technical_login:Boolean(String(process.env.NAV_TECHNICAL_LOGIN||"").trim()),
      technical_password:Boolean(String(process.env.NAV_TECHNICAL_PASSWORD||"").trim()),
      signing_key:Boolean(String(process.env.NAV_SIGNING_KEY||"").trim()),
      exchange_key:Boolean(String(process.env.NAV_EXCHANGE_KEY||"").trim())
    };
    const all_configured=Object.values(credentials).every(Boolean);
    console.info("[NAV-TEST-UAT] credential readiness checked",{run_id:String(claims?.run_id||""),all_configured});
    return res.json({ok:true,credentials,all_configured,secret_values_exposed:false});
  }catch(error:any){
    console.warn("[NAV-TEST-UAT] readiness rejected:",error?.message||String(error));
    return res.status(401).json({error:"Érvénytelen vagy nem engedélyezett GitHub NAV TEST UAT identitás."});
  }
});

router.post("/login", async (req: Request, res: Response) => {
  const { email, identifier, username, login, phone, password } = (req.body || {}) as {
    email?: string;
    identifier?: string;
    username?: string;
    login?: string;
    phone?: string;
    password?: string;
  };

  const loginIdentifier = String(identifier || email || username || login || phone || "").trim();
  const requestedLocationId = requestedLocation(req);
  if (!loginIdentifier || !password) {
    return res.status(400).json({ error: "Hiányzó azonosító vagy jelszó." });
  }

  try {
    const normalizedIdentifier = loginIdentifier.toLocaleLowerCase("hu-HU");
    if (normalizedIdentifier === "könyvelés" || normalizedIdentifier === "konyveles@kleoszalon.hu") {
      await ensureAccountingUser();
    }

    const user = await findUser(loginIdentifier);
    const adminAccount = user && isAdminRole(user.role);
    const employee = adminAccount ? null : await findEmployee(loginIdentifier, user);

    if (employee && (!user || isStaffRole(user.role) || !isAdminRole(user.role))) {
      return respondAsEmployee(res, employee, password, user?.role ?? employee.role, requestedLocationId);
    }

    if (!user) {
      return res.status(401).json({ error: "Hibás felhasználó vagy jelszó." });
    }

    const hash: string | undefined = user.password_hash || user.password;
    if (!hash) {
      return res.status(500).json({ error: "A felhasználóhoz nincs jelszó beállítva." });
    }

    const ok = await verifyPassword(password, hash);
    if (!ok) return res.status(401).json({ error: "Hibás felhasználó vagy jelszó." });

    const admin = isAdminRole(user.role);
    if (requestedLocationId && !admin && String(user.location_id ?? "") !== requestedLocationId) {
      return res.status(403).json({ error: "Ehhez a telephelyhez nincs jogosultságod." });
    }
    const effectiveLocationId = admin && requestedLocationId ? requestedLocationId : (user.location_id ?? null);
    const effectiveLocationName = await locationName(effectiveLocationId);
    const token = jwt.sign(
      {
        id: user.id,
        userId: user.id,
        email: user.email,
        role: user.role,
        location_id: effectiveLocationId,
      },
      JWT_SECRET,
      { expiresIn: "8h" }
    );

    setAuthCookie(res, token);
    return res.json({
      success: true,
      account_type: admin ? "admin" : "customer",
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        location_id: effectiveLocationId,
      },
      role: user.role,
      location_id: effectiveLocationId,
      location_name: effectiveLocationName,
      full_name: user.full_name ?? null,
      email: user.email ?? null,
      login_name: user.login_name ?? null,
      // Transitional compatibility only. Removed after the cookie-only frontend is deployed.
      token,
    });
  } catch (err) {
    console.error("[AUTH] /api/login hiba:", err);
    return res.status(500).json({ error: "Szerver hiba a bejelentkezés közben." });
  }
});

router.post("/employee-login", async (req: Request, res: Response) => {
  const loginName = String(req.body?.login_name || req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  const requestedLocationId = requestedLocation(req);
  if (!loginName || !password) {
    return res.status(400).json({ error: "Hiányzó felhasználónév vagy jelszó." });
  }

  try {
    const employee = await findEmployee(loginName);
    if (!employee) return res.status(401).json({ error: "Hibás felhasználónév vagy jelszó." });
    return respondAsEmployee(res, employee, password, undefined, requestedLocationId);
  } catch (err) {
    console.error("[AUTH] /api/employee-login hiba:", err);
    return res.status(500).json({ error: "Szerver hiba a munkatársi bejelentkezés közben." });
  }
});

router.post("/logout", (_req: Request, res: Response) => {
  clearAuthCookie(res);
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ success: true });
});

export default router;
