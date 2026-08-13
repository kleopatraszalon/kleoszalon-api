import express,{NextFunction,Request,Response} from "express";
import inventoryRouter from "./inventory";
import inventoryControlRouter from "./inventoryControl";
import aiSupportRouter from "./aiSupport";
import collaborationChatRouter from "./collaborationChat";
import cashierRouter from "./cashier";
import cashierRegisterRouter from "./cashierRegister";
import cashierShiftRouter from "./cashierShift";
import workOrderCashierFastRouter from "./workOrderCashierFast";
import financeOperationsRouter from "./financeOperations";
import financeAltegioRouter from "./financeAltegio";
import financeDashboardRouter from "./financeDashboard";
import financeLinkingRouter from "./financeLinking";
import financeControlRouter from "./financeControl";
import systemHealthRouter from "./systemHealth";
import uatTestCenterRouter from "./uatTestCenter";
import uatIssuesRouter from "./uatIssues";
import loyaltyRouter from "./loyalty";
import loyaltyAnalyticsRouter from "./loyaltyAnalytics";
import loyaltyOperationsRouter from "./loyaltyOperations";
import loyaltyPassLookupRouter from "./loyaltyPassLookup";
import loyaltyCommissionRouter from "./loyaltyCommission";
import loyaltyCustomerFinanceRouter from "./loyaltyCustomerFinance";
import loyaltyCashierRouter from "./loyaltyCashier";
import loyaltyAutomationRouter from "./loyaltyAutomation";
import loyaltyProgramRouter from "./loyaltyProgram";
import workOrderFinalizationFastRouter from "./workOrderFinalizationFast";
import workOrderFinalizationRouter from "./workOrderFinalization";
import workOrderFinalizationRecoveryRouter from "./workOrderFinalizationRecovery";
import workOrderInvoiceFastRouter from "./workOrderInvoiceFast";
import workOrderInvoiceChainRouter from "./workOrderInvoiceChain";
import workOrderEditorFastRouter from "./workOrderEditorFast";
import workOrderEditorRouter from "./workOrderEditor";
import workOrderMaterialsRouter from "./workOrderMaterials";
import navOnlineInvoiceRouter from "./navOnlineInvoice";
import navOnlineInvoiceStatusRouter from "./navOnlineInvoiceStatus";
import navInvoiceLifecycleRouter from "./navInvoiceLifecycle";
import navTestUatRouter,{navTestOnlySubmitGuard} from "./navTestUat";
import notificationsRouter from "./notifications";
import managementSummaryRouter from "./managementSummary";
import dashboardSettingsRouter from "./dashboardSettings";
import auditLogRouter from "./auditLog";
import purchaseOrdersRouter from "./purchaseOrders";
import suppliersRouter from "./suppliers";
import procurementWorkflowRouter from "./procurementWorkflow";
import centralSupplyRouter from "./centralSupply";
import bookingOperationsRouter from "./bookingOperations";
import bookingCommunicationsRouter from "./bookingCommunications";
import bookingVoiceStatsRouter from "./bookingVoiceStats";
import appointmentLifecycleRouter from "./appointmentLifecycle";
import bookingWorkOrderBridgeRouter from "./bookingWorkOrderBridge";
import hrDevelopmentRouter from "./hrDevelopment";
import operationsQualityRouter from "./operationsQuality";
import newslettersRouter from "./newsletters";
import knowledgeBaseRouter from "./knowledgeBase";
import dailyActionsRouter from "./dailyActions";
import centralMasterDataRouter from "./centralMasterData";
import workOrderFinanceScope from "../middleware/workOrderFinanceScope";
import db from "../db";
import { requireAuth } from "../middleware/auth";
import { requireManagement } from "../middleware/requireRoles";
import { requirePurchaseOrderAccess, requireProcurementWorkflowAccess } from "../middleware/procurementAccess";
import { requireMenuPermission, requireMenuPermissionByMethod } from "../middleware/menuPermission";
import { requireFeature } from "../middleware/featureAccess";
import {ensureFinanceNav} from "../finance/ensureFinanceNav";
import ensureBookingVoiceStats from "../booking/ensureBookingVoiceStats";

const router=express.Router();

const ensureFinanceReady=async(_req:Request,res:Response,next:NextFunction)=>{
  try{await ensureFinanceNav();next()}
  catch(error:any){
    const stage=error?.stage?String(error.stage):null;
    const dbCode=error?.dbCode?String(error.dbCode):(error?.code?String(error.code):null);
    console.error('Finance/NAV schema bootstrap hiba:',{stage,dbCode,message:error?.message||String(error)});
    res.status(503).json({
      ok:false,
      error:'finance_schema_unavailable',
      message:'A pénzügyi/NAV adatbázis séma jelenleg nem kész. A rendszer automatikusan újrapróbálja.',
      bootstrap_stage:stage,
      db_code:dbCode,
      detail:process.env.NODE_ENV==='development'?String(error?.message||error):undefined
    })
  }
};
const ensureVoiceStatsReady=async(_req:Request,res:Response,next:NextFunction)=>{try{await ensureBookingVoiceStats();next()}catch(error:any){console.error('Voice Booking statisztika bootstrap hiba:',error?.message||error);res.status(503).json({ok:false,error:'booking_voice_stats_schema_unavailable',message:'A Voice Booking statisztikai séma jelenleg nem kész.',detail:process.env.NODE_ENV==='development'?String(error?.message||error):undefined})}};
const guardSettlementLifecycle=async(req:Request,res:Response,next:NextFunction)=>{try{if(req.method!=='POST')return next();const m=String(req.path||'').match(/^\/workorders\/([^/]+)\/settle\/?$/);if(!m)return next();const id=decodeURIComponent(m[1]);const q=await db.query(`SELECT w.work_order_number,w.status,NULLIF(to_jsonb(w)->>'locked_at','')::timestamptz locked_at,NULLIF(to_jsonb(w)->>'archived_at','')::timestamptz archived_at,NULLIF(to_jsonb(w)->>'financial_closed_at','')::timestamptz financial_closed_at FROM work_orders w WHERE w.id::text=$1 LIMIT 1`,[id]);const wo=q.rows[0];if(!wo)return res.status(404).json({message:'A munkalap nem található.'});if(wo.locked_at||wo.archived_at)return res.status(409).json({message:`A(z) ${wo.work_order_number||'munkalap'} lezárt és archivált; további fizetés nem rögzíthető.`});if(wo.financial_closed_at)return res.status(409).json({message:'A munkalap pénzügyileg már lezárt; újabb fizetés vagy elszámolás nem rögzíthető.'});if(['cancelled','no_show','completed'].includes(String(wo.status||'')))return res.status(409).json({message:'Megszakított vagy lezárt munkalap pénzügyileg nem módosítható.'});next()}catch(error:any){if(error?.code==='22P02')return res.status(400).json({message:'Érvénytelen munkalapazonosító.'});next(error)}};
const guardOpenCashierShift=async(req:Request,res:Response,next:NextFunction)=>{try{
  if(req.method!=='POST')return next();
  const path=String(req.path||'');
  const needsShift=/^\/workorders\/[^/]+\/settle\/?$/.test(path)||/^\/register-movements(?:\/[^/]+\/void)?\/?$/.test(path);
  if(!needsShift)return next();
  const locationId=String((req.query as any)?.location_id??req.body?.location_id??res.locals.workOrderFinanceLocationId??'').trim();
  if(!locationId)return res.status(400).json({message:'Ehhez a pénztári művelethez telephely és nyitott pénztári műszak szükséges.'});
  const exists=(await db.query(`SELECT to_regclass('public.cash_register_shifts') IS NOT NULL ok`)).rows[0]?.ok;
  if(!exists)return res.status(409).json({message:'A pénztári műszak nincs megnyitva. Előbb rögzítsd a nyitópénzt.'});
  const shift=(await db.query(`SELECT id,status,current_cashier FROM cash_register_shifts WHERE location_id=$1 AND status='open' ORDER BY opened_at DESC LIMIT 1`,[locationId])).rows[0];
  if(!shift)return res.status(409).json({message:'A művelet csak nyitott pénztári műszakban végezhető. Függő átadás-átvétel esetén előbb fogadd el az átvételt.'});
  res.locals.cashierShift=shift;next();
}catch(error){next(error)}};
const parseRoles=(raw:any)=>{if(Array.isArray(raw))return raw.map(String).map(x=>x.toLowerCase());try{const parsed=JSON.parse(String(raw||''));if(Array.isArray(parsed))return parsed.map(String).map(x=>x.toLowerCase())}catch{}return String(raw||'').split(',').map(x=>x.replace(/[\[\]"]/g,'').trim().toLowerCase()).filter(Boolean)};
const guardCashierHistoryRole=(req:Request,res:Response,next:NextFunction)=>{
  if(req.method!=='GET'||!/^\/shift-history\/?$/.test(String(req.path||'')))return next();
  const roles=parseRoles((req as any).user?.role);
  const allowed=new Set(['admin','administrator','rendszergazda','superadmin','super_admin','location_manager','salon_manager','szalonvezető','szalonvezeto','üzletvezető','uzletvezeto','store_manager','branch_manager']);
  if(roles.some(role=>allowed.has(role)))return next();
  return res.status(403).json({message:'A vezetői kasszatörténet csak adminisztrátor, szalonvezető vagy üzletvezető számára érhető el.'});
};

router.use(requireAuth);

router.get("/",(_req,res)=>res.json([{id:1,type:"income",amount:10000}]));
router.use("/inventory",requireFeature("inventory"),requireMenuPermissionByMethod("inventory"),inventoryRouter);
router.use("/inventory-control",requireFeature("inventory"),requireMenuPermissionByMethod("inventory"),inventoryControlRouter);
router.use("/procurement",requirePurchaseOrderAccess,purchaseOrdersRouter);
router.use("/procurement-workflow",requireProcurementWorkflowAccess,procurementWorkflowRouter);
router.use("/central-supply",requireProcurementWorkflowAccess,centralSupplyRouter);
router.use("/suppliers",requireFeature("procurement"),requireMenuPermissionByMethod("procurement.suppliers"),suppliersRouter);
router.use("/ai-support",aiSupportRouter);router.use("/staff-chat",collaborationChatRouter);
router.use("/booking-operations",bookingOperationsRouter);router.use("/booking-communications",bookingCommunicationsRouter);router.use("/booking-voice-stats",ensureVoiceStatsReady,requireMenuPermission("appointments.voice_stats","can_view"),bookingVoiceStatsRouter);router.use("/appointment-lifecycle",appointmentLifecycleRouter);router.use("/booking-workorder",bookingWorkOrderBridgeRouter);
router.use("/hr-development",requireManagement,hrDevelopmentRouter);
router.use("/operations-quality",requireManagement,operationsQualityRouter);
router.use("/newsletters",requireManagement,newslettersRouter);
router.use("/knowledge-base",knowledgeBaseRouter);
router.use("/daily-actions",requireManagement,dailyActionsRouter);
router.use("/masterdata",requireManagement,centralMasterDataRouter);

router.use("/workorder-editor",workOrderEditorFastRouter);
router.use("/workorder-editor",workOrderEditorRouter);
router.use("/workorder-materials",workOrderMaterialsRouter);

router.use("/cashier",workOrderFinanceScope,ensureFinanceReady,guardCashierHistoryRole,requireFeature("finance"),requireMenuPermissionByMethod("finance.checkout"),cashierShiftRouter);
router.use("/cashier",workOrderFinanceScope,ensureFinanceReady,guardOpenCashierShift,requireFeature("finance"),requireMenuPermissionByMethod("finance.checkout"),cashierRegisterRouter);
router.use("/cashier",workOrderFinanceScope,ensureFinanceReady,guardOpenCashierShift,requireFeature("finance"),requireMenuPermissionByMethod("finance.checkout"),workOrderCashierFastRouter);
router.use("/cashier",workOrderFinanceScope,ensureFinanceReady,guardOpenCashierShift,guardSettlementLifecycle,requireFeature("finance"),requireMenuPermissionByMethod("finance.checkout"),cashierRouter);
router.use("/finance-operations/altegio",ensureFinanceReady,requireFeature("finance"),requireMenuPermissionByMethod("finance"),financeAltegioRouter);
router.use("/finance-operations",ensureFinanceReady,requireFeature("finance"),requireMenuPermissionByMethod("finance"),financeOperationsRouter);
router.use("/finance-dashboard",ensureFinanceReady,requireFeature("finance"),requireMenuPermissionByMethod("finance"),financeDashboardRouter);
router.use("/finance-linking",ensureFinanceReady,requireFeature("finance"),requireMenuPermissionByMethod("finance"),financeLinkingRouter);
router.use("/finance-control",ensureFinanceReady,requireFeature("finance"),requireMenuPermissionByMethod("finance"),financeControlRouter);
router.use("/loyalty",loyaltyRouter);
router.use("/loyalty-analytics",loyaltyAnalyticsRouter);
router.use("/loyalty-operations",loyaltyPassLookupRouter);
router.use("/loyalty-operations",loyaltyOperationsRouter);
router.use("/loyalty-commission",loyaltyCommissionRouter);
router.use("/loyalty-v4",loyaltyCustomerFinanceRouter);

router.use("/loyalty-cashier",workOrderFinanceScope,ensureFinanceReady,guardOpenCashierShift,requireFeature("finance"),requireMenuPermissionByMethod("finance.checkout"),workOrderCashierFastRouter);
router.use("/loyalty-cashier",workOrderFinanceScope,ensureFinanceReady,guardOpenCashierShift,guardSettlementLifecycle,requireFeature("finance"),requireMenuPermissionByMethod("finance.checkout"),loyaltyCashierRouter);

router.use("/workorder-finalization",workOrderFinanceScope,requireFeature("finance"),requireMenuPermissionByMethod("finance.checkout"),workOrderFinalizationFastRouter);
router.use("/workorder-finalization",workOrderFinanceScope,requireFeature("finance"),requireMenuPermissionByMethod("finance.checkout"),workOrderFinalizationRecoveryRouter);
router.use("/workorder-finalization",workOrderFinanceScope,requireFeature("finance"),requireMenuPermissionByMethod("finance.checkout"),workOrderFinalizationRouter);

router.use("/workorder-invoice",requireFeature("finance"),requireMenuPermissionByMethod("finance"),workOrderInvoiceFastRouter);
router.use("/workorder-invoice",ensureFinanceReady,requireFeature("finance"),requireMenuPermissionByMethod("finance"),workOrderInvoiceChainRouter);
router.use("/nav-online-invoice",navTestOnlySubmitGuard);
router.use("/nav-online-invoice",ensureFinanceReady,requireFeature("finance"),requireMenuPermissionByMethod("finance"),navOnlineInvoiceRouter);
router.use("/nav-online-invoice",ensureFinanceReady,requireFeature("finance"),requireMenuPermissionByMethod("finance"),navOnlineInvoiceStatusRouter);
router.use("/nav-online-invoice",ensureFinanceReady,requireFeature("finance"),requireMenuPermissionByMethod("finance"),navInvoiceLifecycleRouter);
router.use("/nav-test-uat",requireManagement,ensureFinanceReady,requireFeature("finance"),navTestUatRouter);
router.use("/loyalty-automation",loyaltyAutomationRouter);
router.use("/loyalty-program",requireManagement,loyaltyProgramRouter);
router.use("/system-health",requireManagement,ensureFinanceReady,systemHealthRouter);
router.use("/uat",requireManagement,uatTestCenterRouter);
router.use("/uat-issues",requireManagement,uatIssuesRouter);
router.use("/cashier/management-summary",ensureFinanceReady,requireFeature("management_dashboard"),requireMenuPermission("finance","can_view_financial"),managementSummaryRouter);
router.use("/management",requireFeature("management_dashboard"),requireMenuPermission("analytics","can_view_financial"),managementSummaryRouter);
router.use("/dashboard-settings",requireFeature("management_dashboard"),dashboardSettingsRouter);
router.use("/notifications",notificationsRouter);router.use("/audit",requireFeature("audit"),requireMenuPermission("settings.audit","can_view"),auditLogRouter);
export default router;