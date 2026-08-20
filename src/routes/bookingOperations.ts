import {Router} from "express";
import bookingOperationsCoreRouter from "./bookingOperationsCore";
import bookingAdvancedRouter from "./bookingAdvanced";
import bookingSmartWaitlistRouter from "./bookingSmartWaitlist";

const router=Router();

// A meglévő várólista/szünet/áthelyezés/ismétlés útvonalak változatlanul megmaradnak.
router.use(bookingOperationsCoreRouter);
// Smart Waitlist: lemondásból kapacitás, rangsorolás, ajánlat és foglalásba emelés.
router.use("/smart-waitlist",bookingSmartWaitlistRouter);
// Stage 15: Altegio-paritás – erőforrások, több szakember és 4Hands.
router.use("/advanced",bookingAdvancedRouter);

export default router;
