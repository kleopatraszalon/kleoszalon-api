import {Router} from 'express';
import clientDuplicateReviewRouter from './clientDuplicateReview';
import clientFormVersionsFinalRouter from './clientFormVersionsFinal';
import clientGovernanceRouter from './clientGovernance';
import systemHardeningRouter from './systemHardening';
import clientReceptionContextRouter from './clientReceptionContext';
import marketingAutomationRouter from './marketingAutomation';
import clientDetailRecoveryRouter from './clientDetailRecovery';
import customerIntelligenceRouter from './customerIntelligence';
import nbaMarketingAutomationRouter from './nbaMarketingAutomation';
import nbaAttributionAdminRouter from './nbaAttributionAdmin';
import bookingClientSearchRouter from './bookingClientSearch';
import clientListRecoveryRouter from './clientListRecovery';
import clientRead500HotfixRouter from './clientRead500Hotfix';
import clientsCoreRouter from './clientsCore';

const router=Router();
// The booking picker uses a deliberately lightweight search before the broader
// CRM/list routers. It avoids downloading the full guest database on modal open.
router.use(bookingClientSearchRouter);
// Critical list/detail reads must run before any optional CRM/governance bootstrap middleware.
// This keeps appointment guest selection available even when a legacy CRM row contains
// schema-drifted values that older reads cannot cast safely.
router.use(clientListRecoveryRouter);
router.use(clientRead500HotfixRouter);
router.use('/system-hardening',systemHardeningRouter);
router.use(clientDuplicateReviewRouter);
router.use(clientFormVersionsFinalRouter);
router.use(clientGovernanceRouter);
router.use(clientReceptionContextRouter);
router.use('/marketing-automation',marketingAutomationRouter);
router.use(clientDetailRecoveryRouter);
router.use('/intelligence/attribution',nbaAttributionAdminRouter);
router.use('/intelligence/marketing',nbaMarketingAutomationRouter);
router.use('/intelligence',customerIntelligenceRouter);
router.use(clientsCoreRouter);

export default router;