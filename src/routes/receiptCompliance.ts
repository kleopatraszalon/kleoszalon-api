import { Router } from "express";
import receiptComplianceV2 from "./receiptComplianceV2";
import receiptIssuance from "./receiptIssuance";

const router = Router();
router.use(receiptComplianceV2);
router.use(receiptIssuance);

export default router;
