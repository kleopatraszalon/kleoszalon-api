import {Router} from "express";
import bookingOperationsCoreRouter from "./bookingOperationsCore";
import bookingAdvancedRouter from "./bookingAdvanced";

const router=Router();

// A meglévő várólista/szünet/áthelyezés/ismétlés útvonalak változatlanul megmaradnak.
router.use(bookingOperationsCoreRouter);
// Stage 15: Altegio-paritás – erőforrások, több szakember és 4Hands.
router.use("/advanced",bookingAdvancedRouter);

export default router;
