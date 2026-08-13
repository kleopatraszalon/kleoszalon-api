import {Router} from 'express';
import clientGovernanceRouter from './clientGovernance';
import systemHardeningRouter from './systemHardening';
import clientsCoreRouter from './clientsCore';

const router=Router();
router.use('/system-hardening',systemHardeningRouter);
router.use(clientGovernanceRouter);
router.use(clientsCoreRouter);

export default router;
