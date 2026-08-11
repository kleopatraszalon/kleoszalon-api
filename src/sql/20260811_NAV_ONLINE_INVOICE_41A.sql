BEGIN;

ALTER TABLE finance_invoice_lines
  ADD COLUMN IF NOT EXISTS nav_line_number_reference integer;

-- A normál számlák összege továbbra sem lehet negatív, de a NAV korrekciós
-- lánc MODIFY/STORNO bizonylatai jogszerűen tartalmazhatnak negatív összegeket.
ALTER TABLE finance_invoices DROP CONSTRAINT IF EXISTS finance_invoices_amount_ck;
ALTER TABLE finance_invoices DROP CONSTRAINT IF EXISTS finance_invoices_amount_by_type_ck;
ALTER TABLE finance_invoices ADD CONSTRAINT finance_invoices_amount_by_type_ck CHECK(
  upper(COALESCE(invoice_type,'NORMAL')) IN ('MODIFY','STORNO')
  OR (net_total>=0 AND vat_total>=0 AND gross_total>=0)
) NOT VALID;

-- A már létező korrekciós draftok sorreferenciáit determinisztikusan
-- visszatöltjük. Az eredeti számla sorai után a teljes korrekciós láncban
-- folyamatos, egyedi lineNumberReference készül.
WITH ranked AS (
  SELECT
    l.id,
    i.original_invoice_id,
    row_number() OVER(
      PARTITION BY i.original_invoice_id
      ORDER BY COALESCE(i.modification_index,2147483647),l.line_number,l.id
    )::integer AS correction_rank
  FROM finance_invoice_lines l
  JOIN finance_invoices i ON i.id=l.invoice_id
  WHERE i.original_invoice_id IS NOT NULL
    AND upper(COALESCE(i.invoice_type,'')) IN ('MODIFY','STORNO')
), numbered AS (
  SELECT
    r.id,
    (SELECT count(*)::integer FROM finance_invoice_lines original_line WHERE original_line.invoice_id=r.original_invoice_id)
      + r.correction_rank AS nav_reference
  FROM ranked r
)
UPDATE finance_invoice_lines l
SET nav_line_number_reference=n.nav_reference
FROM numbered n
WHERE l.id=n.id
  AND l.nav_line_number_reference IS NULL;

CREATE INDEX IF NOT EXISTS finance_invoice_lines_nav_reference_idx
  ON finance_invoice_lines(nav_line_number_reference)
  WHERE nav_line_number_reference IS NOT NULL;

COMMIT;
