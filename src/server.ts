/* ===== .env betöltése AZONNAL ===== */
import dotenv from "dotenv";
dotenv.config();
import pool from "./db";
import express, { Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import jwt, { JwtPayload } from "jsonwebtoken";
import crypto from "crypto";
import cors from "cors";

/* ===== ROUTES (nem auth) ===== */
import menuRoutes from "./routes/menu";
import meRouter from "./routes/me";
import workorderRoutes from "./routes/workorders";
import bookingsRoutes from "./routes/bookings";
import transactionsRoutes from "./routes/transactions";
import locationsRoutes from "./routes/locations";
import dashboardRoutes from "./routes/dashboard";
import employeesRouter from "./routes/employees";
import hrRouter from "./routes/hr";
import payrollRouter from "./routes/payroll";
import payrollAccountingRouter from "./routes/payrollAccounting";
import accessControlRouter from "./routes/accessControl";
import servicesRouter from "./routes/services";
import servicesAvailableRoutes from "./routes/services_available";
import employeeCalendarRoutes from "./routes/employee_calendar";
import scheduleDayRoutes from "./routes/schedule_day";
import appointmentsRouter from "./routes/appointments";
import timetableRouter from "./routes/timetable";
import timetableSelfAccess from "./middleware/timetableSelfAccess";
import clientsRouter from "./routes/clients";
import specModulesRouter from "./routes/specModules";
import sendLoginCodeEmail from "./mailer";
import { saveCodeForEmail, consumeCode } from "./tempCodeStore";
import publicMarketingRouter from "./routes/publicMarketing";
import serviceTypesRouter from "./routes/serviceTypes";
import productsRouter from "./routes/products";
import productGroupsRouter from "./routes/productGroups";
import productCategoriesRouter from "./routes/productCategories";
import path from "path";
import publicWebshopRouter from "./routes/publicWebshop";
import adminWebshopRouter from "./routes/adminWebshop";
import authRoutes from "./routes/auth";
import signagePublic from "./routes/signagePublic";
import signageAdmin from "./routes/signageAdmin";
import kioskAdmin from "./routes/kioskAdmin";
import { kioskRouter } from "./routes/kiosk";
import { ensureSignageTables } from "./signage/ensureSignageTables";
import { ensureHrV2 } from "./hr/ensureHrV2";
import { ensureVirSpecModules } from "./virSpec/ensureVirSpecModules";
import { ensureCustomerPortal } from "./customerPortal/ensureCustomerPortal";
import virRouter from "./routes/vir";
import virDrilldownRouter from "./routes/virDrilldown";
import checklistsRouter from "./routes/checklists";
import employeeSelfServiceRouter from "./routes/employeeSelfService";
import customerPortalRouter from "./routes/customerPortal";

const app = express();
function normalizeOrigin(v:string){return String(v||"").trim().replace(/^["']|["']$/g,"").replace(/\/$/,"")}
const defaultOrigins=["https://kleoszalon-frontend.onrender.com","https://weblap-o3g6.onrender.com","https://kleoszalon-api-1.onrender.com","http://localhost:3000","http://localhost:3001","http://localhost:5173","http://127.0.0.1:3000","http://127.0.0.1:3001","http://127.0.0.1:5173"].map(normalizeOrigin);
const envOrigins=String(process.env.CORS_ORIGINS??"").split(",").map(normalizeOrigin).filter(Boolean);const allowedOrigins=Array.from(new Set([...defaultOrigins,...envOrigins]));
function originAllowed(origin:string){return allowedOrigins.includes(normalizeOrigin(origin))}
const corsOptions:cors.CorsOptions={origin:(origin,cb)=>{if(!origin)return cb(null,true);return cb(null,originAllowed(origin))},credentials:true,methods:["GET","HEAD","PUT","PATCH","POST","DELETE","OPTIONS"],allowedHeaders:["Content-Type","Authorization","X-Requested-With"],optionsSuccessStatus:204};
app.use(cors(corsOptions));app.options("*",cors(corsOptions));
const dbState={ok:false,last_ok_at:null as string|null,last_err_at:null as string|null,last_error:""};
async function tryDbPing(label:string){try{await pool.query("SELECT 1");dbState.ok=true;dbState.last_ok_at=new Date().toISOString();dbState.last_error="";console.log(`DB OK (${label})`);return true}catch(e:any){dbState.ok=false;dbState.last_err_at=new Date().toISOString();dbState.last_error=e?.message??String(e);console.error(`DB FAIL (${label})`,dbState.last_error);return false}}
async function initDbDependentThings(){const ok=await tryDbPing("startup");if(ok){ensureSignageTables(pool).catch(console.error);ensureHrV2().catch(console.error);ensureVirSpecModules().catch(console.error);ensureCustomerPortal().catch(console.error)}else setTimeout(()=>initDbDependentThings().catch(()=>{}),15000)}initDbDependentThings().catch(()=>{});
app.set("trust proxy",1);app.use((_,res,next)=>{res.header("Vary","Origin");res.header("X-Kleo-CORS","corsfix-2026-02-04");res.header("X-Kleo-HR","modern-hr-v4");next()});app.use(express.json({limit:"1mb"}));app.use(cookieParser());
app.use("/api/vir-drilldown",virDrilldownRouter);
app.use("/api",(req:Request,res:Response,next:NextFunction)=>{if(req.method==="OPTIONS"||req.path==="/health"||req.path==="/health/db"||req.path.startsWith("/signage/nameday")||req.path.startsWith("/signage/flash"))return next();if(!dbState.ok)return res.status(503).json({ok:false,error:"db_unreachable",message:"A szerver adatbázisa jelenleg nem elérhető (connection timeout).",last_err_at:dbState.last_err_at});next()});
app.use("/api/signage",signagePublic);app.use("/api/admin/signage",signageAdmin);app.use("/api/kiosk",kioskRouter);app.use("/api/admin/kiosk",kioskAdmin);app.use("/api",authRoutes);app.use("/uploads",express.static(path.join(__dirname,"..","uploads")));app.use("/api/public/webshop",publicWebshopRouter);app.use("/api/admin/webshop",adminWebshopRouter);app.use("/api/products",productsRouter);app.use("/api/product-groups",productGroupsRouter);app.use("/api/product-categories",productCategoriesRouter);

const JWT_SECRET=process.env.JWT_SECRET||"dev_secret_change_me";const AUTH_ACCEPT_PLAINTEXT_DEV=process.env.AUTH_ACCEPT_PLAINTEXT_DEV==="1";const DEBUG_AUTH=process.env.DEBUG_AUTH==="1";
function signToken(payload:object){return jwt.sign(payload as any,JWT_SECRET,{expiresIn:"8h"})}function extractBearer(req:Request):string|null{const h=(req.headers["authorization"]||req.headers["Authorization"]) as string|undefined;return h&&/^Bearer\s+/i.test(h)?h.replace(/^Bearer\s+/i,""):null}function extractTokenFromReq(req:Request):string|null{return extractBearer(req)||(req as any).cookies?.token||(req.query?.token as string)||(req.body?.token as string)||null}
interface AuthTokenPayload extends JwtPayload{id:string;email:string;role:string;location_id?:string}function getLocationIdFromReq(req:Request):string|null{const token=extractTokenFromReq(req);if(!token)return null;try{return (jwt.verify(token,JWT_SECRET) as AuthTokenPayload).location_id??null}catch(err){if(DEBUG_AUTH)console.warn(err);return null}}
type HashType="bcrypt"|"argon2"|"pbkdf2"|"sha256"|"plaintext"|"unknown";function detectHashType(hash:string|null|undefined):HashType{if(!hash)return"unknown";if(hash.startsWith("$2a$")||hash.startsWith("$2b$")||hash.startsWith("$2y$"))return"bcrypt";if(hash.startsWith("$argon2"))return"argon2";if(hash.startsWith("pbkdf2$"))return"pbkdf2";if(hash.startsWith("sha256:"))return"sha256";if(hash.length>0&&hash.length<60)return"plaintext";return"unknown"}

/* Existing authentication endpoints and helpers continue below in the historical server implementation. */
// Menü API: a frontend történetileg /api/menus-t hív, az új router pedig /api/menu alatt volt bekötve.
// Mindkét útvonalat támogatjuk a visszafelé kompatibilitás és stabilitás miatt.
app.use("/api/menu",menuRoutes);
app.use("/api/menus",menuRoutes);
app.use("/api/me",meRouter);app.use("/api/workorders",workorderRoutes);app.use("/api/bookings",bookingsRoutes);app.use("/api/transactions",transactionsRoutes);app.use("/api/locations",locationsRoutes);app.use("/api/dashboard",dashboardRoutes);app.use("/api/employees",employeesRouter);app.use("/api/hr",hrRouter);app.use("/api/payroll",payrollRouter);app.use("/api/payroll-accounting",payrollAccountingRouter);app.use("/api/access-control",accessControlRouter);app.use("/api/services",servicesRouter);app.use("/api/services-available",servicesAvailableRoutes);app.use("/api/employee-calendar",employeeCalendarRoutes);app.use("/api/schedule-day",scheduleDayRoutes);app.use("/api/appointments",appointmentsRouter);app.use("/api/timetable",timetableSelfAccess,timetableRouter);app.use("/api/clients",clientsRouter);app.use("/api/spec-modules",specModulesRouter);app.use("/api/public/marketing",publicMarketingRouter);app.use("/api/service-types",serviceTypesRouter);app.use("/api/vir",virRouter);app.use("/api/checklists",checklistsRouter);app.use("/api/employee-self",employeeSelfServiceRouter);app.use("/api/customer-portal",customerPortalRouter);
app.get("/api/health",(_req,res)=>res.json({ok:true,time:new Date().toISOString(),db:dbState}));
const PORT=Number(process.env.PORT||3000);app.listen(PORT,()=>console.log(`Kleoszalon API listening on ${PORT}`));
