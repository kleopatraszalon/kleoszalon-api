import {Router} from 'express';
import clientDuplicateReviewRouter from './clientDuplicateReview';
import clientFormVersionsRouter from './clientFormVersions';
import clientGovernanceRouter from './clientGovernance';
import systemHardeningRouter from './systemHardening';
import clientsCoreRouter from './clientsCore';

const router=Router();
router.use('/system-hardening',systemHardeningRouter);
router.use(clientDuplicateReviewRouter);
router.use(clientFormVersionsRouter);
router.use(clientGovernanceRouter);
router.use(clientsCoreRouter);

export default router;
