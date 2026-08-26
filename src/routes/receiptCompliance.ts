import { Router } from "express";
import db from "../db";
import receiptDocumentsCompliance from "./receiptDocumentsCompliance";
import receiptComplianceV2 from "./receiptComplianceV2";
import receiptIssuance from "./receiptIssuance";
import legalEntitiesRouter from "./legalEntities";

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
router.use("/legal-entities",legalEntitiesRouter);
router.use(receiptDocumentsCompliance);
router.use(receiptComplianceV2);
router.use(receiptIssuance);

export default router;