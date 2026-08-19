import { Router } from "express";
import legacyVirRouter from "./virLegacy";
import migrationCenterRouter from "./migrationCenter";

const router=Router();
router.use("/migration-center",migrationCenterRouter);
router.use("/",legacyVirRouter);

export default router;
