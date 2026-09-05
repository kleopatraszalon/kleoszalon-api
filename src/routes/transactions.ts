import express,{NextFunction,Request,Response} from "express";
import inventoryRouter from "./inventory";
import inventoryControlRouter from "./inventoryControl";
import aiSupportRouter from "./aiSupport";
import collaborationChatRouter from "./collaborationChat";
import cashierRouter from "./cashier";
import cashierRegisterRouter from "./cashierRegister";
import cashierShiftRouter from "./cashierShift";
import cashierAltegioParityRouter from "./cashierAltegioParity";
import retailProducts500HotfixRouter from "./retailProducts500Hotfix";
import workOrderCashierFastRouter from "./workOrderCashierFast";
import workOrderSettlementErrorRecovery from "./workOrderSettlementErrorRecovery";
import financeOperationsRouter from "./financeOperations";
import financeAltegioRouter from "./financeAltegio";
import financeAltegioV5Router from "./financeAltegioV5";
import financeDashboardRouter from "./financeDashboard";
import financeLinkingRouter from "./financeLinking";
import financeControlRouter from "./financeControl";
import systemHealthRouter from "./systemHealth";
import releaseControlRouter from "./releaseControl";
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
import navQueueWorkerRouter from "./navQueueWorker";
import navTestUatRouter,{navTestOnlySubmitGuard} from "./navTestUat";
import notificationsRouter from "./notifications";
import managementSummaryRouter from "./managementSummary";
import dashboardSettingsRouter from "./dashboardSettings";
import auditLogRouter from "./auditLog";
import gdprRouter from "./gdpr";
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
import dailyActionAutoSelectorRouter from "./dailyActionAutoSelector";
import centralMasterDataRouter from "./centralMasterData";
import workOrderFinanceScope from "../middleware/workOrderFinanceScope";
import {enforceProcessIntegrityReleaseGate} from "../middleware/releaseControlProcessIntegrity";
import db from "../db";
import { requireAuth } from "../middleware/auth";
import { requireManagement } from "../middleware/requireRoles";
import { requirePurchaseOrderAccess, requireProcurementWorkflowAccess } from "../middleware/procurementAccess";
import { requireMenuPermission, requireMenuPermissionByMethod } from "../middleware/menuPermission";
import { requireFeature } from "../middleware/featureAccess";
import {ensureFinanceNav} from "../finance/ensureFinanceNav";
import {ensureSalonDefaultLegalEntities} from "../finance/ensureSalonDefaultLegalEntities";
import {ensureWorkOrderOperationalFinance} from "../finance/ensureWorkOrderOperationalFinance";
import {ensureNavInvoiceCore,getNavInvoiceBootstrapState} from "../finance/ensureNavInvoiceCore";
import {getNavXsdRuntimeInfo} from "../nav/navXsdValidator";
import ensureBookingVoiceStats from "../booking/ensureBookingVoiceStats";

const router=express.Router();

const ensureFinanceReady=async(_req:Request,res:Response,next:NextFunction)=>{
  try{await ensureFinanceNav();await ensureSalonDefaultLegalEntities();next()}
  catch(error:any){
    const stage=error?.stage?String(error.stage):null;
    const dbCode=error?.dbCode?String(error.dbCode):(error?.code?String(error.code):null);
    console.error('Finance/NAV schema bootstrap hiba:',{stage,dbCode,message:error?.message||String(error)});
    res.status(503).json({ok:false,error:'finance_schema_unavailable',message:'A pénzügyi/NAV adatbázis séma jelenleg nem kész. A rendszer automatikusan újrapróbálja.',bootstrap_stage:stage,db_code:dbCode,detail:process.env.NODE_ENV==='development'?String(error?.message||error):undefined})
  }
};
const ensureWorkOrderFinanceReady=async(_req:Request,res:Response,next:NextFunction)=>{
  try{await ensureWorkOrderOperationalFinance();next()}
  catch(error:any){
    const dbCode=error?.code?String(error.code):null;
    console.error('Munkalap operatív pénzügyi bootstrap hiba:',{dbCode,message:error?.message||String(error)});
    res.status(503).json({ok:false,error:'workorder_finance_schema_unavailable',message:'A munkalap fizetési sémája jelenleg nem kész. A NAV teszt/számlázási állapota ettől független.',db_code:dbCode,detail:process.env.NODE_ENV==='development'?String(error?.message||error):undefined})
  }
};
const ensureNavInvoiceReady=async(_req:Request,res:Response,next:NextFunction)=>{
  try{await ensureNavInvoiceCore();next()}
  catch(error:any){
    const state=getNavInvoiceBootstrapState();
    const stage=error?.stage?String(error.stage):state.stage;
    const dbCode=error?.dbCode?String(error.dbCode):(error?.code?String(error.code):state.db_code);
    console.error('NAV Online Számla core bootstrap hiba:',{stage,dbCode,constraint:state.constraint,message:error?.message||String(error)});
    res.status(503).json({ok:false,error:'nav_schema_unavailable',message:'A NAV Online Számla adatbázis-mag jelenleg nem kész. A rendszer automatikusan újrapróbálja.',bootstrap_stage:stage,db_code:dbCode,constraint:state.constraint,bootstrap_state:state,detail:process.env.NODE_ENV==='development'?String(error?.message||error):undefined})
  }
};
const ensureVoiceStatsReady=async(_req:Request,res:Response,next:NextFunction)=>{try{await ensureBookingVoiceStats();next()}catch(error:any){console.error('Voice Booking statisztika bootstrap hiba:',error?.message||error);res.status(503).json({ok:false,error:'booking_voice_stats_schema_unavailable',message:'A Voice Booking statisztikai séma jelenleg nem kész.',detail:process.env.NODE_ENV==='development'?String(error?.message||error):undefined})}};
const guardSettlementLifecycle=async(req:Request,res:Response,next:NextFunction)=>{try{if(req.method!=='POST')return next();const m=String(req.path||'').match(/^\/workorders\/([^/]+)\/settle\/?$/);if(!m)return next();const id=decodeURIComponent(m[1]);const q=await db.query(`SELECT w.work_order_number,w.status,NULLIF(to_jsonb(w)->>'locked_at','')::timestamptz locked_at,NULLIF(to_jsonb(w)->>'archived_at','')::timestamptz archived_at,NULLIF(to_jsonb(w)->>'financial_closed_at','')::timestamptz financial_closed_at FROM work_orders w WHERE w.id::text=$1 LIMIT 1`,[id]);const wo=q.rows[0];if(!wo)return res.status(404).json({message:'A munkalap nem található.'});if(wo.locked_at||wo.archived_at)return res.status(409).json({message:`A(z) ${wo.work_order_number||'munkalap'} lezárt és archivált; további fizetés nem rögzíthető.`});if(wo.financial_closed_at)return res.status(409).json({message:'A munkalap pénzügyileg már lezárt; újabb fizetés vagy elszámolás nem rögzíthető.'});if(['cancelled','no_show','completed'].includes(String(wo.status||'')))return res.status(409).json({message:'Megszakított vagy lezárt munkalap pénzügyileg nem módosítható.'});next()}catch(error:any){if(error?.code==='22P02')return res.status(400).json({message:'Érvénytelen munkalapazonosító.'});next(error)}};
const normalizePaymentMethod=(raw:any)=>{const method=String(raw||'').trim().toLowerCase();if(method==='bank_card'||method==='bankcard')return 'card';if(method==='bank_transfer'||method==='banktransfer')return 'transfer';return method};
const guardOpenCashierShift=async(req:Request,res:Response,next:NextFunction)=>{try{
  if(req.method!=='POST')return next();
  const path=String(req.path||'');
  const isSettlement=/^\/workorders\/[^/]+\/settle\/?$/.test(path);
  const isRegisterMovement=/^\/register-movements(?:\/[^/]+\/void)?\/?$/.test(path);
  if(!isSettlement&&!isRegisterMovement)return next();

  const payments=Array.isArray(req.body?.payments)?req.body.payments:[];
  const hasCashPayment=isSettlement&&payments.some((p:any)=>normalizePaymentMethod(p?.payment_method)==='cash');
  // A pénztári műszak üzleti szabály kizárólag valódi kasszamozgásra vonatkozik.
  // Kártya, átutalás, utalvány és egyéb munkalapfizetés nem blokkolható nyitott kassza hiánya miatt.
  if(isSettlement&&!hasCashPayment)return next();

  const locationId=String((req.query as any)?.location_id??req.body?.location_id??res.locals.workOrderFinanceLocationId??'').trim();
  if(!locationId)return res.status(400).json({message:'Ehhez a pénztári művelethez telephely és nyitott pénztári műszak szükséges.',error_code:'CASHIER_LOCATION_REQUIRED'});
  const exists=(await db.query(`SELECT to_regclass('public.cash_register_shifts') IS NOT NULL ok`)).rows[0]?.ok;
  if(!exists)return res.status(409).json({message:'A pénztári műszak nincs megnyitva. Előbb rögzítsd a nyitópénzt.',error_code:'CASHIER_SHIFT_REQUIRED'});
  const shift=(await db.query(`SELECT id,status,current_cashier FROM cash_register_shifts WHERE location_id=$1 AND status='open' ORDER BY opened_at DESC LIMIT 1`,[locationId])).rows[0];
  if(!shift)return res.status(409).json({message:'A művelet csak nyitott pénztári műszakban végezhető. Függő átadás-átvétel esetén előbb fogadd el az átvételt.',error_code:'CASHIER_SHIFT_REQUIRED'});
  res.locals.cashierShift=shift;
  if(isSettlement){
    req.body.payments=payments.map((p:any)=>normalizePaymentMethod(p?.payment_method)==='cash'?{...p,cashier_shift_id:p?.cashier_shift_id||shift.id}:p);
  }
  return next();
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
router.use("/daily-actions/auto-selector",requireManagement,dailyActionAutoSelectorRouter);
router.use("/daily-actions",requireManagement,dailyActionsRouter);
router.use("/masterdata",requireManagement,centralMasterDataRouter);

// A munkalap szerkesztése és pénztára operatív funkció: NAV bootstrap hiba nem blokkolhatja.
router.use("/workorder-editor",ensureWorkOrderFinanceReady,workOrderEditorFastRouter);
router.use("/workorder-editor",ensureWorkOrderFinanceReady,workOrderEditorRouter);
router.use("/workorder-materials",workOrderMaterialsRouter);

router.use("/cashier",workOrderFinanceScope,ensureWorkOrderFinanceReady,guardCashierHistoryRole,requireFeature("finance"),requireMenuPermissionByMethod("finance.checkout"),cashierShiftRouter);
router.use("/cashier",workOrderFinanceScope,ensureWorkOrderFinanceReady,guardOpenCashierShift,requireFeature("finance"),requireMenuPermissionByMethod("finance.checkout"),cashierAltegioParityRouter);
router.use("/cashier",workOrderFinanceScope,ensureWorkOrderFinanceReady,guardOpenCashierShift,requireFeature("finance"),requireMenuPermissionByMethod("finance.checkout"),cashierRegisterRouter);
router.use("/cashier",workOrderFinanceScope,ensureWorkOrderFinanceReady,guardOpenCashierShift,requireFeature("finance"),requireMenuPermissionByMethod("finance.checkout"),retailProducts500HotfixRouter);
router.use("/cashier",workOrderFinanceScope,ensureWorkOrderFinanceReady,guardOpenCashierShift,requireFeature("finance"),requireMenuPermissionByMethod("finance.checkout"),workOrderCashierFastRouter);
router.use("/cashier",workOrderFinanceScope,ensureWorkOrderFinanceReady,guardOpenCashierShift,guardSettlementLifecycle,requireFeature("finance"),requireMenuPermissionByMethod("finance.checkout"),cashierRouter);
router.use("/cashier",workOrderSettlementErrorRecovery);
router.use("/finance-operations/altegio",ensureFinanceReady,requireFeature("finance"),requireMenuPermissionByMethod("finance"),financeAltegioRouter);
router.use("/finance-operations",ensureFinanceReady,requireFeature("finance"),requireMenuPermissionByMethod("finance"),financeOperationsRouter);
router.use("/finance-v5",ensureFinanceReady,requireFeature("finance"),financeAltegioV5Router);
router.use("/finance-dashboard",ensureFinanceReady,requireFeature("finance"),requireMenuPermissionByMethod("finance"),financeDashboardRouter);
router.use("/finance-linking",ensureFinanceReady,requireFeature("finance"),requireMenuPermissionByMethod("finance"),financeLinkingRouter);
router.use("/finance-control",ensureFinanceReady,requireFeature("finance"),requireMenuPermissionByMethod("finance"),financeControlRouter);
router.use("/loyalty",loyaltyRouter);
router.use("/loyalty-analytics",loyaltyAnalyticsRouter);
router.use("/loyalty-operations",loyaltyPassLookupRouter);
router.use("/loyalty-operations",loyaltyOperationsRouter);
router.use("/loyalty-commission",loyaltyCommissionRouter);
router.use("/loyalty-v4",loyaltyCustomerFinanceRouter);

router.use("/loyalty-cashier",workOrderFinanceScope,ensureWorkOrderFinanceReady,guardOpenCashierShift,requireFeature("finance"),requireMenuPermissionByMethod("finance.checkout"),cashierAltegioParityRouter);
router.use("/loyalty-cashier",workOrderFinanceScope,ensureWorkOrderFinanceReady,guardOpenCashierShift,requireFeature("finance"),requireMenuPermissionByMethod("finance.checkout"),retailProducts500HotfixRouter);
router.use("/loyalty-cashier",workOrderFinanceScope,ensureWorkOrderFinanceReady,guardOpenCashierShift,requireFeature("finance"),requireMenuPermissionByMethod("finance.checkout"),workOrderCashierFastRouter);
router.use("/loyalty-cashier",workOrderFinanceScope,ensureWorkOrderFinanceReady,guardOpenCashierShift,guardSettlementLifecycle,requireFeature("finance"),requireMenuPermissionByMethod("finance.checkout"),loyaltyCashierRouter);
router.use("/loyalty-cashier",workOrderSettlementErrorRecovery);

// Végleges lezárás is recepciós operatív feladat; NAV csak külön számlázási route-on kötelező.
router.use("/workorder-finalization",workOrderFinanceScope,ensureWorkOrderFinanceReady,requireFeature("finance"),requireMenuPermissionByMethod("finance.checkout"),workOrderFinalizationFastRouter);
router.use("/workorder-finalization",workOrderFinanceScope,ensureWorkOrderFinanceReady,requireFeature("finance"),requireMenuPermissionByMethod("finance.checkout"),workOrderFinalizationRecoveryRouter);
router.use("/workorder-finalization",workOrderFinanceScope,ensureWorkOrderFinanceReady,requireFeature("finance"),requireMenuPermissionByMethod("finance.checkout"),workOrderFinalizationRouter);

router.get("/nav-online-invoice/bootstrap-status",requireManagement,async(_req,res)=>{
  const before=getNavInvoiceBootstrapState();
  try{await ensureNavInvoiceCore();res.json({ok:true,bootstrap:getNavInvoiceBootstrapState()})}
  catch(error:any){res.status(503).json({ok:false,bootstrap:getNavInvoiceBootstrapState(),message:String(error?.message||error),previous:before})}
});
router.get("/nav-online-invoice/runtime-status",requireManagement,async(_req,res)=>{
  try{const xsd=await getNavXsdRuntimeInfo();res.json({ok:true,xsd,bootstrap:getNavInvoiceBootstrapState(),fail_closed:true})}
  catch(error:any){res.status(503).json({ok:false,xsd:{ready:false,message:String(error?.message||error)},bootstrap:getNavInvoiceBootstrapState(),fail_closed:true})}
});

// NAV csak a tényleges számlázási/beküldési útvonalakon marad fail-closed.
router.use("/workorder-invoice",ensureNavInvoiceReady,requireFeature("finance"),requireMenuPermissionByMethod("finance"),workOrderInvoiceFastRouter);
router.use("/workorder-invoice",ensureNavInvoiceReady,requireFeature("finance"),requireMenuPermissionByMethod("finance"),workOrderInvoiceChainRouter);
router.use("/nav-online-invoice",navTestOnlySubmitGuard);
router.use("/nav-online-invoice",ensureNavInvoiceReady,requireFeature("finance"),requireMenuPermissionByMethod("finance"),navQueueWorkerRouter);
router.use("/nav-online-invoice",ensureNavInvoiceReady,requireFeature("finance"),requireMenuPermissionByMethod("finance"),navOnlineInvoiceRouter);
router.use("/nav-online-invoice",ensureNavInvoiceReady,requireFeature("finance"),requireMenuPermissionByMethod("finance"),navOnlineInvoiceStatusRouter);
router.use("/nav-online-invoice",ensureNavInvoiceReady,requireFeature("finance"),requireMenuPermissionByMethod("finance"),navInvoiceLifecycleRouter);
router.use("/nav-test-uat",requireManagement,ensureNavInvoiceReady,requireFeature("finance"),navTestUatRouter);
router.use("/loyalty-automation",loyaltyAutomationRouter);
router.use("/loyalty-program",requireManagement,loyaltyProgramRouter);
router.use("/system-health",requireManagement,ensureFinanceReady,systemHealthRouter);
router.use("/release-control",requireManagement,enforceProcessIntegrityReleaseGate,releaseControlRouter);
router.use("/uat",requireManagement,uatTestCenterRouter);
router.use("/uat-issues",requireManagement,uatIssuesRouter);
router.use("/cashier/management-summary",ensureFinanceReady,requireFeature("management_dashboard"),requireMenuPermission("finance","can_view_financial"),managementSummaryRouter);
router.use("/management",requireFeature("management_dashboard"),requireMenuPermission("analytics","can_view_financial"),managementSummaryRouter);
router.use("/dashboard-settings",requireFeature("management_dashboard"),dashboardSettingsRouter);
router.use("/notifications",notificationsRouter);router.use("/audit",requireFeature("audit"),requireMenuPermission("settings.audit","can_view"),auditLogRouter);
router.use("/gdpr",gdprRouter);
export default router;