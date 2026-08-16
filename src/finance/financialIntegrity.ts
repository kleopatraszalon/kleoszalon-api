import type { PoolClient } from 'pg';

export class FinancialIntegrityError extends Error {
  status: number;
  publicCode: string;
  constructor(status: number, message: string, publicCode = 'financial_integrity_error') {
    super(message);
    this.name = 'FinancialIntegrityError';
    this.status = status;
    this.publicCode = publicCode;
  }
}

export function requireIdempotencyKey(req: any, scope: string) {
  const value = String(req.get?.('Idempotency-Key') || req.headers?.['idempotency-key'] || req.body?.idempotency_key || '').trim();
  if (!/^[A-Za-z0-9._:-]{8,120}$/.test(value)) {
    throw new FinancialIntegrityError(400, 'A pénzügyi írási művelethez 8–120 karakteres Idempotency-Key fejléc szükséges.', 'finance_idempotency_key_required');
  }
  return `${scope}:${value}`;
}

type ReverseInput = {
  movementId: string;
  actor: string;
  reason: string;
  locationId?: string | null;
  includeFees?: boolean;
};

export async function reverseFinancialMovement(client: PoolClient, input: ReverseInput) {
  const reason = String(input.reason || '').trim();
  if (reason.length < 3) throw new FinancialIntegrityError(400, 'A sztornó indoka legalább 3 karakter.', 'finance_reversal_reason_required');

  const params: any[] = [input.movementId];
  let scope = '';
  if (input.locationId) { params.push(input.locationId); scope = ` AND location_id::text=$${params.length}`; }
  const original = (await client.query(`SELECT * FROM financial_movements WHERE id=$1::uuid${scope} FOR UPDATE`, params)).rows[0];
  if (!original) throw new FinancialIntegrityError(404, 'A pénzügyi művelet nem található.', 'finance_movement_not_found');
  if (original.reversal_of_id || original.payment_status === 'reversal') {
    throw new FinancialIntegrityError(409, 'Ellenkönyvelési tétel nem sztornózható.', 'finance_reversal_of_reversal_forbidden');
  }
  if (original.reversed_by_id || original.cancelled_at) {
    const reversal = original.reversed_by_id
      ? (await client.query('SELECT * FROM financial_movements WHERE id=$1::uuid', [original.reversed_by_id])).rows[0]
      : null;
    if (!reversal) throw new FinancialIntegrityError(409, 'A tétel sztornójelölése sérült; vezetői egyeztetés szükséges.', 'finance_reversal_link_missing');
    return { original, reversal, fee_reversals: [], idempotent: true };
  }

  const reversal = (await client.query(`
    INSERT INTO financial_movements(
      location_id,account_id,category_id,direction,amount,occurred_at,reference_type,reference_id,
      counterparty,note,created_by,partner_id,payment_method_id,document_id,client_id,employee_id,
      service_id,product_id,visit_id,work_order_id,payment_status,fee_for_movement_id,
      reversal_of_id,posting_group_id,idempotency_key
    )
    SELECT location_id,account_id,category_id,
      CASE WHEN direction='income' THEN 'expense' ELSE 'income' END,amount,now(),'reversal',id::text,
      counterparty,$2,$3,partner_id,payment_method_id,document_id,client_id,employee_id,
      service_id,product_id,visit_id,work_order_id,'reversal',fee_for_movement_id,
      id,COALESCE(posting_group_id,gen_random_uuid()),'reversal:'||id::text
    FROM financial_movements WHERE id=$1::uuid
    RETURNING *`, [original.id, reason, input.actor])).rows[0];

  await client.query(`UPDATE financial_movements
    SET payment_status='cancelled',cancelled_at=now(),cancelled_by=$2,cancellation_reason=$3,reversed_by_id=$4,updated_at=now()
    WHERE id=$1::uuid`, [original.id, input.actor, reason, reversal.id]);
  await client.query(`INSERT INTO finance_integrity_events(event_type,location_key,subject_type,subject_id,actor,reason,evidence)
    VALUES('movement_reversed',COALESCE($1,'__global__'),'financial_movement',$2,$3,$4,$5::jsonb)`,
    [original.location_id == null ? null : String(original.location_id), String(original.id), input.actor, reason, JSON.stringify({ reversal_id: reversal.id, amount: original.amount, original_direction: original.direction })]);

  const feeReversals: any[] = [];
  if (input.includeFees !== false) {
    const fees = (await client.query(`SELECT id FROM financial_movements
      WHERE fee_for_movement_id=$1::uuid AND reversed_by_id IS NULL AND reversal_of_id IS NULL FOR UPDATE`, [original.id])).rows;
    for (const fee of fees) {
      const result = await reverseFinancialMovement(client, { ...input, movementId: String(fee.id), reason: `Kapcsolt díj sztornó: ${reason}`, includeFees: false });
      feeReversals.push(result.reversal);
    }
  }
  return { original, reversal, fee_reversals: feeReversals, idempotent: false };
}
