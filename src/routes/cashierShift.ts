import { Router } from "express";
import db from "../db";
import type { AuthRequest } from "../middleware/auth";
import { generateCashierClosePdf } from "../services/cashierClosePdf";

const router = Router();
const money = (value: unknown) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};
const actor = (req: AuthRequest) => req.user?.email || String(req.user?.id || "");
const locationFrom = (req: AuthRequest) => String(req.query.location_id ?? req.body?.location_id ?? "").trim();
const dateKey = (value: any) => String(value || "").slice(0, 10);

async function ensureSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS cash_register_movements (
      id bigserial PRIMARY KEY,
      location_id text NOT NULL,
      business_date date NOT NULL DEFAULT CURRENT_DATE,
      direction varchar(8) NOT NULL CHECK (direction IN ('in','out')),
      amount numeric(14,2) NOT NULL CHECK (amount > 0),
      reason_code varchar(40) NOT NULL DEFAULT 'other',
      note text,
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      voided_at timestamptz,
      voided_by text,
      void_reason text
    );

    ALTER TABLE cash_register_closings
      ADD COLUMN IF NOT EXISTS cash_in numeric(14,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS cash_out numeric(14,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS shift_id bigint,
      ADD COLUMN IF NOT EXISTS report_no text;

    CREATE TABLE IF NOT EXISTS cash_register_shifts (
      id bigserial PRIMARY KEY,
      location_id text NOT NULL,
      location_name text,
      business_date date NOT NULL,
      status varchar(24) NOT NULL DEFAULT 'open',
      opening_cash numeric(14,2) NOT NULL DEFAULT 0,
      opening_note text,
      opened_by text NOT NULL,
      opened_at timestamptz NOT NULL DEFAULT now(),
      current_cashier text NOT NULL,
      closed_by text,
      closed_at timestamptz,
      closing_id bigint,
      report_no text,
      close_note text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (status IN ('open','handover_pending','closed'))
    );
    CREATE INDEX IF NOT EXISTS cash_register_shifts_history_idx
      ON cash_register_shifts (location_id,business_date DESC,opened_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS cash_register_shifts_one_open_uq
      ON cash_register_shifts (location_id)
      WHERE status IN ('open','handover_pending');

    CREATE TABLE IF NOT EXISTS cash_register_handovers (
      id bigserial PRIMARY KEY,
      shift_id bigint NOT NULL,
      location_id text NOT NULL,
      business_date date NOT NULL,
      status varchar(20) NOT NULL DEFAULT 'pending',
      from_cashier text NOT NULL,
      to_cashier text NOT NULL,
      expected_cash numeric(14,2) NOT NULL DEFAULT 0,
      counted_cash numeric(14,2) NOT NULL DEFAULT 0,
      difference numeric(14,2) NOT NULL DEFAULT 0,
      note text,
      handed_over_at timestamptz NOT NULL DEFAULT now(),
      accepted_by text,
      accepted_counted_cash numeric(14,2),
      accepted_difference numeric(14,2),
      accept_note text,
      accepted_at timestamptz,
      cancelled_by text,
      cancelled_at timestamptz,
      cancel_reason text,
      CHECK (status IN ('pending','accepted','cancelled'))
    );
    CREATE INDEX IF NOT EXISTS cash_register_handovers_shift_idx
      ON cash_register_handovers (shift_id,handed_over_at DESC);

    CREATE TABLE IF NOT EXISTS cash_register_close_reports (
      id bigserial PRIMARY KEY,
      shift_id bigint NOT NULL UNIQUE,
      closing_id bigint,
      report_no text NOT NULL UNIQUE,
      location_id text NOT NULL,
      location_name text,
      business_date date NOT NULL,
      opening_cash numeric(14,2) NOT NULL DEFAULT 0,
      cash_sales numeric(14,2) NOT NULL DEFAULT 0,
      card_sales numeric(14,2) NOT NULL DEFAULT 0,
      transfer_sales numeric(14,2) NOT NULL DEFAULT 0,
      voucher_sales numeric(14,2) NOT NULL DEFAULT 0,
      other_sales numeric(14,2) NOT NULL DEFAULT 0,
      tips numeric(14,2) NOT NULL DEFAULT 0,
      discounts numeric(14,2) NOT NULL DEFAULT 0,
      cash_in numeric(14,2) NOT NULL DEFAULT 0,
      cash_out numeric(14,2) NOT NULL DEFAULT 0,
      expected_cash numeric(14,2) NOT NULL DEFAULT 0,
      counted_cash numeric(14,2) NOT NULL DEFAULT 0,
      difference numeric(14,2) NOT NULL DEFAULT 0,
      handover_count integer NOT NULL DEFAULT 0,
      opened_by text,
      opened_at timestamptz,
      closed_by text,
      closed_at timestamptz NOT NULL DEFAULT now(),
      close_note text,
      snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS cash_register_close_reports_history_idx
      ON cash_register_close_reports (business_date DESC,location_id,closed_at DESC);
  `);
}

const ready = async (_req: AuthRequest, _res: any, next: any) => {
  try {
    await ensureSchema();
    next();
  } catch (error) {
    next(error);
  }
};

async function registerTotals(client: any, locationId: string, businessDate: string) {
  const payments = await client.query(
    `SELECT
       COALESCE(SUM(CASE WHEN wp.payment_method='cash' THEN wp.amount ELSE 0 END),0)::numeric cash_sales,
       COALESCE(SUM(CASE WHEN wp.payment_method='card' THEN wp.amount ELSE 0 END),0)::numeric card_sales,
       COALESCE(SUM(CASE WHEN wp.payment_method='transfer' THEN wp.amount ELSE 0 END),0)::numeric transfer_sales,
       COALESCE(SUM(CASE WHEN wp.payment_method='voucher' THEN wp.amount ELSE 0 END),0)::numeric voucher_sales,
       COALESCE(SUM(CASE WHEN wp.payment_method='other' THEN wp.amount ELSE 0 END),0)::numeric other_sales,
       COUNT(DISTINCT wp.work_order_id)::int workorder_count
     FROM work_order_payments wp
     JOIN work_orders wo ON wo.id=wp.work_order_id
     WHERE wp.paid_at::date=$1::date AND wo.location_id::text=$2`,
    [businessDate, locationId],
  );
  const orders = await client.query(
    `SELECT COALESCE(SUM(tip_amount),0)::numeric tips,
            COALESCE(SUM(discount_amount),0)::numeric discounts
     FROM work_orders
     WHERE financial_closed_at::date=$1::date AND location_id::text=$2`,
    [businessDate, locationId],
  );
  const movements = await client.query(
    `SELECT
       COALESCE(SUM(amount) FILTER(WHERE direction='in' AND voided_at IS NULL),0)::numeric cash_in,
       COALESCE(SUM(amount) FILTER(WHERE direction='out' AND voided_at IS NULL),0)::numeric cash_out
     FROM cash_register_movements
     WHERE location_id=$1 AND business_date=$2::date`,
    [locationId, businessDate],
  );
  const p = payments.rows[0] || {};
  const o = orders.rows[0] || {};
  const m = movements.rows[0] || {};
  return {
    cash_sales: money(p.cash_sales),
    card_sales: money(p.card_sales),
    transfer_sales: money(p.transfer_sales),
    voucher_sales: money(p.voucher_sales),
    other_sales: money(p.other_sales),
    workorder_count: Number(p.workorder_count || 0),
    tips: money(o.tips),
    discounts: money(o.discounts),
    cash_in: money(m.cash_in),
    cash_out: money(m.cash_out),
  };
}

async function expectedForShift(client: any, shift: any) {
  const totals = await registerTotals(client, String(shift.location_id), dateKey(shift.business_date_key || shift.business_date));
  const expected_cash = money(Number(shift.opening_cash || 0) + totals.cash_sales + totals.cash_in - totals.cash_out);
  return { ...totals, expected_cash };
}

async function loadHandovers(client: any, shiftId: any) {
  return (
    await client.query(
      `SELECT *,to_char(business_date,'YYYY-MM-DD') business_date_key
       FROM cash_register_handovers WHERE shift_id=$1 ORDER BY handed_over_at,id`,
      [shiftId],
    )
  ).rows;
}

router.get('/shift/current', ready, async (req: AuthRequest, res, next) => {
  try {
    const locationId = locationFrom(req);
    if (!locationId) return res.status(400).json({ message: 'A telephely kiválasztása kötelező.' });
    const businessDate = String(req.query.date || new Date().toISOString().slice(0,10));
    const active = await db.query(
      `SELECT *,to_char(business_date,'YYYY-MM-DD') business_date_key
       FROM cash_register_shifts
       WHERE location_id=$1 AND status IN ('open','handover_pending')
       ORDER BY opened_at DESC LIMIT 1`,
      [locationId],
    );
    const shift = active.rows[0] || null;
    let totals = null, handovers: any[] = [], pending_handover = null;
    if (shift) {
      totals = await expectedForShift(db, shift);
      handovers = await loadHandovers(db, shift.id);
      pending_handover = handovers.find((h:any) => h.status === 'pending') || null;
    }
    const latestReport = await db.query(
      `SELECT *,to_char(business_date,'YYYY-MM-DD') business_date_key
       FROM cash_register_close_reports
       WHERE location_id=$1 AND business_date=$2::date
       ORDER BY closed_at DESC LIMIT 1`,
      [locationId,businessDate],
    );
    res.json({ shift, totals, handovers, pending_handover, latest_report: latestReport.rows[0] || null });
  } catch (error) { next(error); }
});

router.post('/shift/open', ready, async (req: AuthRequest, res, next) => {
  const client = await db.connect();
  try {
    const locationId = locationFrom(req);
    if (!locationId) return res.status(400).json({ message: 'A telephely kiválasztása kötelező.' });
    const businessDate = String(req.body?.business_date || new Date().toISOString().slice(0,10));
    const openingCash = Math.max(0,money(req.body?.opening_cash));
    const locationName = String(req.body?.location_name || '').trim() || null;
    const note = String(req.body?.opening_note || '').trim() || null;
    await client.query('BEGIN');
    const existing = await client.query(`SELECT id,status FROM cash_register_shifts WHERE location_id=$1 AND status IN ('open','handover_pending') FOR UPDATE`,[locationId]);
    if (existing.rows[0]) { await client.query('ROLLBACK'); return res.status(409).json({ message:'Ehhez a telephelyhez már van nyitott pénztári műszak.' }); }
    const closed = await client.query(`SELECT id FROM cash_register_closings WHERE location_id=$1 AND business_date=$2::date LIMIT 1`,[locationId,businessDate]);
    if (closed.rows[0]) { await client.query('ROLLBACK'); return res.status(409).json({ message:'A kiválasztott üzleti nap pénztára már le van zárva.' }); }
    const user = actor(req);
    const inserted = await client.query(
      `INSERT INTO cash_register_shifts(location_id,location_name,business_date,opening_cash,opening_note,opened_by,current_cashier)
       VALUES($1,$2,$3::date,$4,$5,$6,$6)
       RETURNING *,to_char(business_date,'YYYY-MM-DD') business_date_key`,
      [locationId,locationName,businessDate,openingCash,note,user],
    );
    await client.query('COMMIT');
    res.status(201).json(inserted.rows[0]);
  } catch (error) { await client.query('ROLLBACK').catch(()=>undefined); next(error); }
  finally { client.release(); }
});

router.post('/shift/:id/handover', ready, async (req: AuthRequest, res, next) => {
  const client = await db.connect();
  try {
    const locationId = locationFrom(req);
    if (!locationId) return res.status(400).json({ message:'A telephely kiválasztása kötelező.' });
    const toCashier = String(req.body?.to_cashier || '').trim();
    const countedCash = Math.max(0,money(req.body?.counted_cash));
    const note = String(req.body?.note || '').trim() || null;
    if (!toCashier) return res.status(400).json({ message:'Az átvevő pénztáros megadása kötelező.' });
    await client.query('BEGIN');
    const locked = await client.query(`SELECT *,to_char(business_date,'YYYY-MM-DD') business_date_key FROM cash_register_shifts WHERE id=$1 AND location_id=$2 FOR UPDATE`,[req.params.id,locationId]);
    const shift = locked.rows[0];
    if (!shift) { await client.query('ROLLBACK'); return res.status(404).json({ message:'A pénztári műszak nem található.' }); }
    if (shift.status !== 'open') { await client.query('ROLLBACK'); return res.status(409).json({ message:'Átadás csak nyitott pénztári műszaknál indítható.' }); }
    const pending = await client.query(`SELECT id FROM cash_register_handovers WHERE shift_id=$1 AND status='pending' LIMIT 1`,[shift.id]);
    if (pending.rows[0]) { await client.query('ROLLBACK'); return res.status(409).json({ message:'Ehhez a műszakhoz már van függő átadás-átvétel.' }); }
    const totals = await expectedForShift(client,shift);
    const difference = money(countedCash - totals.expected_cash);
    const h = await client.query(
      `INSERT INTO cash_register_handovers(shift_id,location_id,business_date,from_cashier,to_cashier,expected_cash,counted_cash,difference,note)
       VALUES($1,$2,$3::date,$4,$5,$6,$7,$8,$9)
       RETURNING *,to_char(business_date,'YYYY-MM-DD') business_date_key`,
      [shift.id,locationId,shift.business_date_key,shift.current_cashier || actor(req),toCashier,totals.expected_cash,countedCash,difference,note],
    );
    await client.query(`UPDATE cash_register_shifts SET status='handover_pending',updated_at=now() WHERE id=$1`,[shift.id]);
    await client.query('COMMIT');
    res.status(201).json({ handover:h.rows[0], totals });
  } catch (error) { await client.query('ROLLBACK').catch(()=>undefined); next(error); }
  finally { client.release(); }
});

router.post('/shift/:shiftId/handovers/:handoverId/accept', ready, async (req: AuthRequest, res, next) => {
  const client = await db.connect();
  try {
    const locationId = locationFrom(req);
    if (!locationId) return res.status(400).json({ message:'A telephely kiválasztása kötelező.' });
    const acceptedCount = Math.max(0,money(req.body?.counted_cash));
    const note = String(req.body?.note || '').trim() || null;
    await client.query('BEGIN');
    const shiftQ = await client.query(`SELECT * FROM cash_register_shifts WHERE id=$1 AND location_id=$2 FOR UPDATE`,[req.params.shiftId,locationId]);
    const shift = shiftQ.rows[0];
    const hQ = await client.query(`SELECT * FROM cash_register_handovers WHERE id=$1 AND shift_id=$2 AND location_id=$3 FOR UPDATE`,[req.params.handoverId,req.params.shiftId,locationId]);
    const h = hQ.rows[0];
    if (!shift || !h) { await client.query('ROLLBACK'); return res.status(404).json({ message:'Az átadás-átvétel nem található.' }); }
    if (shift.status !== 'handover_pending' || h.status !== 'pending') { await client.query('ROLLBACK'); return res.status(409).json({ message:'Ez az átadás-átvétel már nem fogadható el.' }); }
    const acceptedBy = actor(req);
    const acceptedDifference = money(acceptedCount - money(h.expected_cash));
    const updated = await client.query(
      `UPDATE cash_register_handovers SET status='accepted',accepted_by=$2,accepted_counted_cash=$3,accepted_difference=$4,accept_note=$5,accepted_at=now()
       WHERE id=$1 RETURNING *`,
      [h.id,acceptedBy,acceptedCount,acceptedDifference,note],
    );
    await client.query(`UPDATE cash_register_shifts SET status='open',current_cashier=$2,updated_at=now() WHERE id=$1`,[shift.id,acceptedBy]);
    await client.query('COMMIT');
    res.json(updated.rows[0]);
  } catch (error) { await client.query('ROLLBACK').catch(()=>undefined); next(error); }
  finally { client.release(); }
});

router.post('/shift/:shiftId/handovers/:handoverId/cancel', ready, async (req: AuthRequest, res, next) => {
  const client = await db.connect();
  try {
    const locationId = locationFrom(req);
    if (!locationId) return res.status(400).json({ message:'A telephely kiválasztása kötelező.' });
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ message:'A megszakítás indoka kötelező.' });
    await client.query('BEGIN');
    const shiftQ = await client.query(`SELECT * FROM cash_register_shifts WHERE id=$1 AND location_id=$2 FOR UPDATE`,[req.params.shiftId,locationId]);
    const hQ = await client.query(`SELECT * FROM cash_register_handovers WHERE id=$1 AND shift_id=$2 AND location_id=$3 FOR UPDATE`,[req.params.handoverId,req.params.shiftId,locationId]);
    if (!shiftQ.rows[0] || !hQ.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ message:'Az átadás-átvétel nem található.' }); }
    if (hQ.rows[0].status !== 'pending') { await client.query('ROLLBACK'); return res.status(409).json({ message:'Csak függő átadás-átvétel szakítható meg.' }); }
    await client.query(`UPDATE cash_register_handovers SET status='cancelled',cancelled_by=$2,cancelled_at=now(),cancel_reason=$3 WHERE id=$1`,[req.params.handoverId,actor(req),reason]);
    await client.query(`UPDATE cash_register_shifts SET status='open',updated_at=now() WHERE id=$1`,[req.params.shiftId]);
    await client.query('COMMIT');
    res.json({ ok:true });
  } catch (error) { await client.query('ROLLBACK').catch(()=>undefined); next(error); }
  finally { client.release(); }
});

router.post('/shift/:id/close', ready, async (req: AuthRequest, res, next) => {
  const client = await db.connect();
  try {
    const locationId = locationFrom(req);
    if (!locationId) return res.status(400).json({ message:'A telephely kiválasztása kötelező.' });
    const countedCash = Math.max(0,money(req.body?.counted_cash));
    const closeNote = String(req.body?.note || '').trim() || null;
    await client.query('BEGIN');
    const shiftQ = await client.query(`SELECT *,to_char(business_date,'YYYY-MM-DD') business_date_key FROM cash_register_shifts WHERE id=$1 AND location_id=$2 FOR UPDATE`,[req.params.id,locationId]);
    const shift = shiftQ.rows[0];
    if (!shift) { await client.query('ROLLBACK'); return res.status(404).json({ message:'A pénztári műszak nem található.' }); }
    if (shift.status === 'handover_pending') { await client.query('ROLLBACK'); return res.status(409).json({ message:'Függő átadás-átvétel mellett a pénztár nem zárható.' }); }
    if (shift.status !== 'open') { await client.query('ROLLBACK'); return res.status(409).json({ message:'A pénztári műszak már le van zárva.' }); }
    const totals = await expectedForShift(client,shift);
    const difference = money(countedCash - totals.expected_cash);
    const closedBy = actor(req);
    const reportNo = `KZ-${String(shift.business_date_key).replace(/-/g,'')}-${String(shift.id).padStart(6,'0')}`;
    const handovers = await loadHandovers(client,shift.id);
    const handoverCount = handovers.filter((h:any)=>h.status==='accepted').length;
    const closing = await client.query(
      `INSERT INTO cash_register_closings(location_id,business_date,opening_cash,cash_sales,card_sales,transfer_sales,voucher_sales,other_sales,tips,discounts,cash_in,cash_out,expected_cash,counted_cash,difference,note,closed_by,shift_id,report_no)
       VALUES($1,$2::date,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT(location_id,business_date) DO UPDATE SET
        opening_cash=EXCLUDED.opening_cash,cash_sales=EXCLUDED.cash_sales,card_sales=EXCLUDED.card_sales,transfer_sales=EXCLUDED.transfer_sales,
        voucher_sales=EXCLUDED.voucher_sales,other_sales=EXCLUDED.other_sales,tips=EXCLUDED.tips,discounts=EXCLUDED.discounts,
        cash_in=EXCLUDED.cash_in,cash_out=EXCLUDED.cash_out,expected_cash=EXCLUDED.expected_cash,counted_cash=EXCLUDED.counted_cash,
        difference=EXCLUDED.difference,note=EXCLUDED.note,closed_by=EXCLUDED.closed_by,shift_id=EXCLUDED.shift_id,report_no=EXCLUDED.report_no,closed_at=now()
       RETURNING *`,
      [locationId,shift.business_date_key,money(shift.opening_cash),totals.cash_sales,totals.card_sales,totals.transfer_sales,totals.voucher_sales,totals.other_sales,totals.tips,totals.discounts,totals.cash_in,totals.cash_out,totals.expected_cash,countedCash,difference,closeNote,closedBy,shift.id,reportNo],
    );
    const closedAt = closing.rows[0]?.closed_at || new Date().toISOString();
    const report = await client.query(
      `INSERT INTO cash_register_close_reports(shift_id,closing_id,report_no,location_id,location_name,business_date,opening_cash,cash_sales,card_sales,transfer_sales,voucher_sales,other_sales,tips,discounts,cash_in,cash_out,expected_cash,counted_cash,difference,handover_count,opened_by,opened_at,closed_by,closed_at,close_note,snapshot)
       VALUES($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,'{}'::jsonb)
       ON CONFLICT(shift_id) DO UPDATE SET closing_id=EXCLUDED.closing_id,report_no=EXCLUDED.report_no,counted_cash=EXCLUDED.counted_cash,difference=EXCLUDED.difference,closed_by=EXCLUDED.closed_by,closed_at=EXCLUDED.closed_at,close_note=EXCLUDED.close_note
       RETURNING *,to_char(business_date,'YYYY-MM-DD') business_date_key`,
      [shift.id,closing.rows[0]?.id||null,reportNo,locationId,shift.location_name,shift.business_date_key,money(shift.opening_cash),totals.cash_sales,totals.card_sales,totals.transfer_sales,totals.voucher_sales,totals.other_sales,totals.tips,totals.discounts,totals.cash_in,totals.cash_out,totals.expected_cash,countedCash,difference,handoverCount,shift.opened_by,shift.opened_at,closedBy,closedAt,closeNote],
    );
    const snapshot = { ...report.rows[0], handovers };
    await client.query(`UPDATE cash_register_close_reports SET snapshot=$2::jsonb WHERE id=$1`,[report.rows[0].id,JSON.stringify(snapshot)]);
    await client.query(`UPDATE cash_register_shifts SET status='closed',closed_by=$2,closed_at=$3,closing_id=$4,report_no=$5,close_note=$6,updated_at=now() WHERE id=$1`,[shift.id,closedBy,closedAt,closing.rows[0]?.id||null,reportNo,closeNote]);
    await client.query('COMMIT');
    res.status(201).json({ report:{...report.rows[0],snapshot}, handovers, totals });
  } catch (error) { await client.query('ROLLBACK').catch(()=>undefined); next(error); }
  finally { client.release(); }
});

router.get('/shift-history', ready, async (req: AuthRequest, res, next) => {
  try {
    const locationId = locationFrom(req);
    const from = String(req.query.from || '');
    const to = String(req.query.to || '');
    const limit = Math.min(500,Math.max(1,Number(req.query.limit || 100)));
    const {rows} = await db.query(
      `SELECT *,to_char(business_date,'YYYY-MM-DD') business_date_key
       FROM cash_register_close_reports
       WHERE ($1='' OR location_id=$1)
         AND ($2='' OR business_date>=$2::date)
         AND ($3='' OR business_date<=$3::date)
       ORDER BY business_date DESC,closed_at DESC LIMIT $4`,
      [locationId,from,to,limit],
    );
    const summary = rows.reduce((a:any,r:any)=>{
      a.days+=1;a.cash_sales+=Number(r.cash_sales||0);a.card_sales+=Number(r.card_sales||0);a.difference+=Number(r.difference||0);a.cash_in+=Number(r.cash_in||0);a.cash_out+=Number(r.cash_out||0);return a;
    },{days:0,cash_sales:0,card_sales:0,difference:0,cash_in:0,cash_out:0});
    res.json({ rows, summary });
  } catch (error) { next(error); }
});

router.get('/shift-reports/:id', ready, async (req: AuthRequest, res, next) => {
  try {
    const locationId = locationFrom(req);
    const params:any[]=[req.params.id];let scope='';
    if(locationId){params.push(locationId);scope=` AND location_id=$2`;}
    const report=(await db.query(`SELECT *,to_char(business_date,'YYYY-MM-DD') business_date_key FROM cash_register_close_reports WHERE id=$1${scope} LIMIT 1`,params)).rows[0];
    if(!report)return res.status(404).json({message:'A pénztárzárási jegyzőkönyv nem található.'});
    const handovers=await loadHandovers(db,report.shift_id);
    res.json({report,handovers});
  } catch(error){next(error);}
});

router.get('/shift-reports/:id/pdf', ready, async (req: AuthRequest, res, next) => {
  try {
    const locationId = locationFrom(req);
    const params:any[]=[req.params.id];let scope='';
    if(locationId){params.push(locationId);scope=` AND location_id=$2`;}
    const report=(await db.query(`SELECT *,to_char(business_date,'YYYY-MM-DD') business_date_key FROM cash_register_close_reports WHERE id=$1${scope} LIMIT 1`,params)).rows[0];
    if(!report)return res.status(404).json({message:'A pénztárzárási jegyzőkönyv nem található.'});
    report.business_date=report.business_date_key;
    const handovers=await loadHandovers(db,report.shift_id);
    const pdf=await generateCashierClosePdf({report,handovers});
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition',`inline; filename="${String(report.report_no||'penztarzaras').replace(/[^a-zA-Z0-9_-]/g,'_')}.pdf"`);
    res.send(pdf);
  } catch(error){next(error);}
});

export default router;
