import { Router } from "express";
import db from "../db";
import receiptDocumentsCompliance from "./receiptDocumentsCompliance";
import receiptComplianceV2 from "./receiptComplianceV2";
import receiptIssuance from "./receiptIssuance";
import receiptCompanyIssuanceOverride from "./receiptCompanyIssuanceOverride";
import receiptCompanyLifecycleV2 from "./receiptCompanyLifecycleV2";
import legalEntitiesRouter from "./legalEntities";
import legalEntitiesImportRouter from "./legalEntitiesImport";
import workOrderLegalEntityRouter from "./workOrderLegalEntity";
import externalFinancialDocumentsRouter from "./externalFinancialDocuments";
import externalFinancialDocumentsAltegioRouter from "./externalFinancialDocumentsAltegio";
import externalInvoiceNavBridgeRouter from "./externalInvoiceNavBridge";

const router = Router();
let prereqReady: Promise<void> | null = null;

function ensureReceiptPrerequisites() {
  if (!prereqReady) prereqReady = db.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE IF NOT EXISTS retail_sales(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      location_id text NOT NULL,
      client_id text,
      customer_name text,
      customer_email text,
      customer_phone text,
      payment_method text NOT NULL,
      gross_total numeric(14,2) NOT NULL DEFAULT 0,
      invoice_requested boolean NOT NULL DEFAULT false,
      finance_invoice_id uuid,
      status text NOT NULL DEFAULT 'paid',
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS retail_sale_items(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sale_id uuid NOT NULL REFERENCES retail_sales(id) ON DELETE CASCADE,
      product_id text NOT NULL,
      product_name text NOT NULL,
      quantity numeric(14,3) NOT NULL,
      unit_price_gross numeric(14,2) NOT NULL,
      gross_amount numeric(14,2) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `).then(() => undefined).catch((error) => { prereqReady = null; throw error; });
  return prereqReady;
}

router.use("/documents", async (_req, _res, next) => {
  try { await ensureReceiptPrerequisites(); next(); }
  catch (error) { next(error); }
});
// Az Altegio kiegészítő router kezeli az opcionális élő API-szinkront,
// a provider státuszt és az Altegio location ID megőrzését. Az általános
// külső bizonylat router továbbra is kezeli az Altegio exportfájl-importot.
router.use("/external-documents", externalFinancialDocumentsAltegioRouter);
router.use("/external-documents", externalInvoiceNavBridgeRouter);
router.use("/external-documents", externalFinancialDocumentsRouter);
router.use("/legal-entities",legalEntitiesImportRouter);
router.use("/legal-entities",legalEntitiesRouter);
router.use("/legal-entities",workOrderLegalEntityRouter);
// A V2 életciklus kezeli elsőként a kibocsátást és sztornót. A régi route-ok
// csak a kompatibilis olvasási/PDF/e-mail/audit végpontokhoz maradnak meg.
router.use(receiptCompanyLifecycleV2);
router.use(receiptCompanyIssuanceOverride);
router.use(receiptDocumentsCompliance);
router.use(receiptComplianceV2);
router.use(receiptIssuance);

export default router;