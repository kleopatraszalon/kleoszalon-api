-- db/sql/workorders_list.sql
-- Munkalapok listázása szűrőkkel + lapozással

SELECT
  w.id,
  w.status,
  w.title,
  w.notes,
  w.appointment_id,
  w.location_id,
  w.employee_id,
  w.employee_name,
  w.client_id,
  w.client_name,
  w.subtotal,
  w.discount_total,
  w.tax_total,
  w.grand_total,
  w.created_at,
  w.updated_at
FROM public.v_workorder_details AS w
WHERE
  -- 1) Telephely (location_id, UUID) – ha NULL, akkor nincs szűrés
  ($1::uuid IS NULL OR w.location_id = $1)

  -- 2) Státusz (TEXT) – pl. 'open', 'closed', 'draft', stb.
  AND ($2::text IS NULL OR w.status = $2)

  -- 3) Dátumtól (timestamp without time zone) – ha NULL, nincs alsó határ
  AND ($3::timestamp IS NULL OR w.created_at >= $3)

  -- 4) Dátumig (timestamp without time zone) – ha NULL, nincs felső határ
  AND ($4::timestamp IS NULL OR w.created_at <  $4)

ORDER BY
  w.created_at DESC

-- 5) LIMIT (integer)
LIMIT $5

-- 6) OFFSET (integer)
OFFSET $6;
