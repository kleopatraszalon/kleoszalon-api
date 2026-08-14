import {Router} from 'express';
import clientDuplicateReviewRouter from './clientDuplicateReview';
import clientFormVersionsFinalRouter from './clientFormVersionsFinal';
import clientGovernanceRouter from './clientGovernance';
import systemHardeningRouter from './systemHardening';
import clientReceptionContextRouter from './clientReceptionContext';
import clientsCoreRouter from './clientsCore';

const router=Router();
router.use('/system-hardening',systemHardeningRouter);
router.use(clientDuplicateReviewRouter);
router.use(clientFormVersionsFinalRouter);
router.use(clientGovernanceRouter);
router.use(clientReceptionContextRouter);
router.use(clientsCoreRouter);

export default router;
