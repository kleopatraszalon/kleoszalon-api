import {Router} from 'express';
import clientGovernanceRouter from './clientGovernance';
import clientsCoreRouter from './clientsCore';

const router=Router();
router.use(clientGovernanceRouter);
router.use(clientsCoreRouter);

export default router;
