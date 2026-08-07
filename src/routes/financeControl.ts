import { Router } from "express";
import db from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { requireFeature } from "../middleware/featureAccess";

const router = Router();
router.use(requireAuth);
router.use(requireFeature("finance"));

const actor = (req: AuthRequest) => req.user?.email || String(req.user?.id || "system");

router.get("/summary", async (req: AuthRequest, res, next) => {
  try {
    const locationId = String(req.query.location_id || req.user?.location_id || "").trim();
    const month = String(req.query.month || new Date().toISOString().slice(0, 7));
    await db.query(`UPDATE finance_invoices SET status='overdue',updated_at=now() WHERE status='approved' AND due_date<CURRENT_DATE`);

    const invoice = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status='overdue')::int overdue_count,
        COALESCE(SUM(gross_total) FILTER (WHERE status='overdue'),0)::numeric overdue_total,
        COUNT(*) FILTER (WHERE status IN ('approved','overdue') AND paid_at IS NULL)::int unpaid_count,
        COALESCE(SUM(gross_total) FILTER (WHERE status IN ('approved','overdue') AND paid_at IS NULL),0)::numeric unpaid_total,
        COUNT(*) FILTER (WHERE status IN ('approved','paid','overdue') AND journal_entry_id IS NULL)::int unposted_count,
        COUNT(*) FILTER (WHERE status<>'cancelled' AND (invoice_no IS NULL OR btrim(invoice_no)=''))::int missing_invoice_no_count,
        COUNT(*) FILTER (WHERE status<>'cancelled' AND gross_total>0 AND abs((net_total+vat_total)-gross_total)>1)::int amount_mismatch_count,
        COUNT(*) FILTER (WHERE status<>'cancelled' AND gross_total>0 AND vat_total=0 AND note ILIKE '%ÁFA%')::int vat_review_count
      FROM finance_invoices
      WHERE ($1::text='' OR location_id::text=$1 OR location_id IS NULL)
        AND to_char(issue_date,'YYYY-MM')=$2`, [locationId, month]);

    const journals = await db.query(`
      SELECT COUNT(*)::int unbalanced_count
      FROM (
        SELECT je.id
        FROM accounting_journal_entries je
        JOIN accounting_journal_lines jl ON jl.journal_entry_id=je.id
        WHERE ($1::text='' OR je.location_id::text=$1 OR je.location_id IS NULL)
          AND to_char(je.entry_date,'YYYY-MM')=$2
        GROUP BY je.id
        HAVING abs(COALESCE(SUM(jl.debit),0)-COALESCE(SUM(jl.credit),0))>0.5
      ) x`, [locationId, month]).catch(() => ({ rows: [{ unbalanced_count: 0 }] } as any));

    const cash = await db.query(`
      SELECT COUNT(*) FILTER (WHERE abs(difference)>0.5)::int difference_count,
             COALESCE(SUM(abs(difference)) FILTER (WHERE abs(difference)>0.5),0)::numeric difference_total
      FROM cash_register_closings
      WHERE ($1::text='' OR location_id::text=$1 OR location_id IS NULL)
        AND to_char(business_date,'YYYY-MM')=$2`, [locationId, month]).catch(() => ({ rows: [{ difference_count: 0, difference_total: 0 }] } as any));

    const payroll = await db.query(`
      SELECT COUNT(*) FILTER (WHERE status IN ('approved','paid') AND NOT EXISTS (
        SELECT 1 FROM accounting_journal_entries je WHERE je.source_type='payroll' AND je.source_id=pr.id::text
      ))::int unposted_payroll_count
      FROM payroll_runs pr
      WHERE ($1::text='' OR pr.location_id::text=$1 OR pr.location_id IS NULL)
        AND to_char(pr.period_to,'YYYY-MM')=$2`, [locationId, month]).catch(() => ({ rows: [{ unposted_payroll_count: 0 }] } as any));

    const close = await db.query(`SELECT * FROM finance_period_closings WHERE period_month=$1 AND (($2::text='' AND location_id IS NULL) OR location_id::text=$2) ORDER BY closed_at DESC LIMIT 1`, [month, locationId]).catch(() => ({ rows: [] } as any));
    const i = invoice.rows[0];
    const issues = Number(i.overdue_count||0)+Number(i.unpaid_count||0)+Number(i.unposted_count||0)+Number(i.missing_invoice_no_count||0)+Number(i.amount_mismatch_count||0)+Number(i.vat_review_count||0)+Number(journals.rows[0]?.unbalanced_count||0)+Number(cash.rows[0]?.difference_count||0)+Number(payroll.rows[0]?.unposted_payroll_count||0);
    res.json({ month, location_id: locationId || null, issue_count: issues, invoices: i, journals: journals.rows[0], cash: cash.rows[0], payroll: payroll.rows[0], period_close: close.rows[0] || null });
  } catch (err) { next(err); }
});

router.get("/issues", async (req: AuthRequest, res, next) => {
  try {
    const locationId = String(req.query.location_id || req.user?.location_id || "").trim();
    const month = String(req.query.month || new Date().toISOString().slice(0,7));
    const { rows } = await db.query(`
      SELECT id,'invoice'::text entity_type,COALESCE(invoice_no,id::text) reference,partner_name,
        CASE
          WHEN status='overdue' THEN 'overdue'
          WHEN status IN ('approved','overdue') AND paid_at IS NULL THEN 'unpaid'
          WHEN status IN ('approved','paid','overdue') AND journal_entry_id IS NULL THEN 'unposted'
          WHEN invoice_no IS NULL OR btrim(invoice_no)='' THEN 'missing_invoice_no'
          WHEN abs((net_total+vat_total)-gross_total)>1 THEN 'amount_mismatch'
          WHEN gross_total>0 AND vat_total=0 AND note ILIKE '%ÁFA%' THEN 'vat_review'
        END issue_type,
        gross_total amount,due_date,issue_date,status
      FROM finance_invoices
      WHERE ($1::text='' OR location_id::text=$1 OR location_id IS NULL)
        AND to_char(issue_date,'YYYY-MM')=$2
        AND status<>'cancelled'
        AND (status='overdue' OR (status IN ('approved','overdue') AND paid_at IS NULL)
          OR (status IN ('approved','paid','overdue') AND journal_entry_id IS NULL)
          OR invoice_no IS NULL OR btrim(invoice_no)='' OR abs((net_total+vat_total)-gross_total)>1
          OR (gross_total>0 AND vat_total=0 AND note ILIKE '%ÁFA%'))
      ORDER BY due_date NULLS LAST,issue_date DESC LIMIT 500`, [locationId, month]);
    res.json(rows);
  } catch (err) { next(err); }
});

router.post("/period-close", async (req: AuthRequest, res, next) => {
  try {
    const month = String(req.body?.month || "").trim();
    const locationId = String(req.body?.location_id || req.user?.location_id || "").trim() || null;
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ message: "A hónap formátuma YYYY-MM legyen." });
    const checks = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('approved','overdue') AND paid_at IS NULL)::int unpaid,
        COUNT(*) FILTER (WHERE status IN ('approved','paid','overdue') AND journal_entry_id IS NULL)::int unposted,
        COUNT(*) FILTER (WHERE status<>'cancelled' AND (invoice_no IS NULL OR btrim(invoice_no)=''))::int missing_no,
        COUNT(*) FILTER (WHERE status<>'cancelled' AND abs((net_total+vat_total)-gross_total)>1)::int mismatch
      FROM finance_invoices
      WHERE (($1::text IS NULL AND location_id IS NULL) OR $1::text IS NULL OR location_id::text=$1)
        AND to_char(issue_date,'YYYY-MM')=$2`, [locationId, month]);
    const c = checks.rows[0];
    const blockers = Number(c.unpaid||0)+Number(c.unposted||0)+Number(c.missing_no||0)+Number(c.mismatch||0);
    if (blockers > 0 && !req.body?.force) return res.status(409).json({ message: "A hónap még nem zárható: vannak nyitott pénzügyi ellenőrzési tételek.", checks: c });
    const { rows } = await db.query(`INSERT INTO finance_period_closings(location_id,period_month,status,closed_by,closed_at,note,control_snapshot) VALUES($1,$2,'closed',$3,now(),$4,$5::jsonb) ON CONFLICT(location_id,period_month) DO UPDATE SET status='closed',closed_by=EXCLUDED.closed_by,closed_at=now(),note=EXCLUDED.note,control_snapshot=EXCLUDED.control_snapshot,updated_at=now() RETURNING *`, [locationId, month, actor(req), req.body?.note || null, JSON.stringify(c)]);
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

export default router;
