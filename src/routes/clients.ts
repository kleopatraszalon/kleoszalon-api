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
import clientRead500HotfixRouter from './clientRead500Hotfix';
import clientsCoreRouter from './clientsCore';

const router=Router();
// Critical read recovery must run before any optional CRM/governance bootstrap middleware.
// Otherwise a legacy schema/bootstrap error can turn harmless GET /segments or GET /:id
// into HTTP 500 before the defensive read router gets a chance to answer.
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
