import express,{NextFunction,Request,Response} from "express";
import inventoryRouter from "./inventory";
import inventoryControlRouter from "./inventoryControl";
import aiSupportRouter from "./aiSupport";
import collaborationChatRouter from "./collaborationChat";
import cashierRouter from "./cashier";
import workOrderCashierFastRouter from "./workOrderCashierFast";
import financeOperationsRouter from "./financeOperations";
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
import workOrderFinalizationFastRouter from "./workOrderFinalizationFast";
import workOrderFinalizationRouter from "./workOrderFinalization";
import workOrderFinalizationRecoveryRouter from "./workOrderFinalizationRecovery";
import workOrderInvoiceChainRouter from "./workOrderInvoiceChain";
import workOrderEditorFastRouter from "./workOrderEditorFast";
import workOrderEditorRouter from "./workOrderEditor";
import workOrderMaterialsRouter from "./workOrderMaterials";
import navOnlineInvoiceRouter from "./navOnlineInvoice";
import navOnlineInvoiceStatusRouter from "./navOnlineInvoiceStatus";
import navInvoiceLifecycleRouter from "./navInvoiceLifecycle";
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

// A nehéz Finance/NAV bootstrap csak a teljes pénzügyi moduloknál marad.
// A napi munkalap szerkesztés, fizetés és lezárás külön fast path-on fut.
const ensureFinanceReady=async(_req:Request,res:Response,next:NextFunction)=>{
  try{await ensureFinanceNav();next()}
  catch(error:any){
    console.error('Finance/NAV schema bootstrap hiba:',error?.message||error);
    res.status(503).json({ok:false,error:'finance_schema_unavailable',message:'A pénzügyi/NAV adatbázis séma jelenleg nem kész. A rendszer automatikusan újrapróbálja.',detail:process.env.NODE_ENV==='development'?String(error?.message||error):undefined})
  }
};
const ensureVoiceStatsReady=async(_req:Request,res:Response,next:NextFunction)=>{try{await ensureBookingVoiceStats();next()}catch(error:any){console.error('Voice Booking statisztika bootstrap hiba:',error?.message||error);res.status(503).json({ok:false,error:'booking_voice_stats_schema_unavailable',message:'A Voice Booking statisztikai séma jelenleg nem kész.',detail:process.env.NODE_ENV==='development'?String(error?.message||error):undefined})}};
const guardSettlementLifecycle=async(req:Request,res:Response,next:NextFunction)=>{try{if(req.method!=='POST')return next();const m=String(req.path||'').match(/^\/workorders\/([^/]+)\/settle\/?$/);if(!m)return next();const id=decodeURIComponent(m[1]);const q=await db.query(`SELECT w.work_order_number,w.status,NULLIF(to_jsonb(w)->>'locked_at','')::timestamptz locked_at,NULLIF(to_jsonb(w)->>'archived_at','')::timestamptz archived_at,NULLIF(to_jsonb(w)->>'financial_closed_at','')::timestamptz financial_closed_at FROM work_orders w WHERE w.id::text=$1 LIMIT 1`,[id]);const wo=q.rows[0];if(!wo)return res.status(404).json({message:'A munkalap nem található.'});if(wo.locked_at||wo.archived_at)return res.status(409).json({message:`A(z) ${wo.work_order_number||'munkalap'} lezárt és archivált; további fizetés nem rögzíthető.`});if(wo.financial_closed_at)return res.status(409).json({message:'A munkalap pénzügyileg már lezárt; újabb fizetés vagy elszámolás nem rögzíthető.'});if(Boolean((req as any).body?.close_financially)&&String(wo.status||'')!=='in_progress')return res.status(409).json({message:'Végleges pénzügyi zárás csak Folyamatban állapotú munkalapon végezhető.'});next()}catch(error:any){if(error?.code==='22P02')return res.status(400).json({message:'Érvénytelen munkalapazonosító.'});next(error)}};

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

// Gyors munkalap szerkesztő: a meglévő munkalapnál párhuzamos lekérdezés + rövid cache.
router.use("/workorder-editor",workOrderEditorFastRouter);
router.use("/workorder-editor",workOrderEditorRouter);
router.use("/workorder-materials",workOrderMaterialsRouter);

// Gyors pénztári útvonal a teljes Finance/NAV bootstrap ELŐTT.
router.use("/cashier",workOrderFinanceScope,requireFeature("finance"),requireMenuPermissionByMethod("finance.checkout"),workOrderCashierFastRouter);
router.use("/cashier",workOrderFinanceScope,ensureFinanceReady,guardSettlementLifecycle,requireFeature("finance"),requireMenuPermissionByMethod("finance.checkout"),cashierRouter);
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

// Ha van hűségfiók, de nincs tényleges beváltás, ugyanaz a gyors pénztári útvonal zárja a munkalapot.
router.use("/loyalty-cashier",workOrderFinanceScope,requireFeature("finance"),requireMenuPermissionByMethod("finance.checkout"),workOrderCashierFastRouter);
router.use("/loyalty-cashier",workOrderFinanceScope,ensureFinanceReady,guardSettlementLifecycle,requireFeature("finance"),requireMenuPermissionByMethod("finance.checkout"),loyaltyCashierRouter);

// Gyors véglegesítés/PDF: nincs request-time DDL és nincs SMTP-várakozás.
router.use("/workorder-finalization",workOrderFinanceScope,requireFeature("finance"),requireMenuPermissionByMethod("finance.checkout"),workOrderFinalizationFastRouter);
router.use("/workorder-finalization",workOrderFinanceScope,requireFeature("finance"),requireMenuPermissionByMethod("finance.checkout"),workOrderFinalizationRecoveryRouter);
router.use("/workorder-finalization",workOrderFinanceScope,requireFeature("finance"),requireMenuPermissionByMethod("finance.checkout"),workOrderFinalizationRouter);

router.use("/workorder-invoice",ensureFinanceReady,requireFeature("finance"),requireMenuPermissionByMethod("finance"),workOrderInvoiceChainRouter);
router.use("/nav-online-invoice",ensureFinanceReady,requireFeature("finance"),requireMenuPermissionByMethod("finance"),navOnlineInvoiceRouter);
router.use("/nav-online-invoice",ensureFinanceReady,requireFeature("finance"),requireMenuPermissionByMethod("finance"),navOnlineInvoiceStatusRouter);
router.use("/nav-online-invoice",ensureFinanceReady,requireFeature("finance"),requireMenuPermissionByMethod("finance"),navInvoiceLifecycleRouter);
router.use("/loyalty-automation",loyaltyAutomationRouter);
router.use("/system-health",requireManagement,ensureFinanceReady,systemHealthRouter);
router.use("/uat",requireManagement,uatTestCenterRouter);
router.use("/uat-issues",requireManagement,uatIssuesRouter);
router.use("/cashier/management-summary",ensureFinanceReady,requireFeature("management_dashboard"),requireMenuPermission("finance","can_view_financial"),managementSummaryRouter);
router.use("/management",requireFeature("management_dashboard"),requireMenuPermission("analytics","can_view_financial"),managementSummaryRouter);
router.use("/dashboard-settings",requireFeature("management_dashboard"),dashboardSettingsRouter);
router.use("/notifications",notificationsRouter);router.use("/audit",requireFeature("audit"),requireMenuPermission("settings.audit","can_view"),auditLogRouter);
export default router;
