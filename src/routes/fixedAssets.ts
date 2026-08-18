import { Router } from "express";
import db from "../db";
import { requireAuth } from "../middleware/auth";

const router = Router();

type Row = Record<string, any>;
type JournalLine = {
  account_code: string;
  debit?: number;
  credit?: number;
  cost_center?: string | null;
  asset_id?: string | null;
  partner_id?: string | null;
  memo?: string | null;
};

const VIEW_ROLES = new Set([
  "admin","administrator","rendszergazda","superadmin","super_admin",
  "manager","vezető","vezeto","location_manager","salon_manager","szalonvezető","szalonvezeto",
  "accounting","bookkeeper","konyveles","könyvelés"
]);
const GLOBAL_ROLES = new Set([
  "admin","administrator","rendszergazda","superadmin","super_admin",
  "manager","vezető","vezeto","accounting","bookkeeper","konyveles","könyvelés"
]);
const CONFIG_ROLES = new Set([
  "admin","administrator","rendszergazda","superadmin","super_admin",
  "manager","vezető","vezeto","location_manager","accounting","bookkeeper","konyveles","könyvelés"
]);

function roleList(raw:any):string[]{
  if(Array.isArray(raw)) return raw.map(String).map(v=>v.toLowerCase());
  const text=String(raw??"");
  try{
    const parsed=JSON.parse(text);
    if(Array.isArray(parsed)) return parsed.map(String).map(v=>v.toLowerCase());
  }catch{}
  return text.split(",").map(v=>v.replace(/[\[\]"]/g,"").trim().toLowerCase()).filter(Boolean);
}
function hasRole(req:any, allowed:Set<string>){return roleList(req.user?.role).some(r=>allowed.has(r));}
function globalScope(req:any){return hasRole(req,GLOBAL_ROLES);}
function actor(req:any){return String(req.user?.email||req.user?.id||"system");}
function ownLocation(req:any){const v=req.user?.location_id;return v==null||String(v).trim()===""?null:String(v).trim();}
function selectedLocation(req:any){
  if(!globalScope(req)) return ownLocation(req);
  const v=req.query?.location_id??req.body?.location_id;
  return v==null||String(v).trim()===""?null:String(v).trim();
}
function writeLocation(req:any){
  if(!globalScope(req)){
    const loc=ownLocation(req);
    if(!loc) fail(403,"A felhasználóhoz nincs telephely rendelve.","asset_location_missing");
    return loc;
  }
  const v=req.body?.location_id;
  return v==null||String(v).trim()===""?null:String(v).trim();
}
function fail(status:number,message:string,code="fixed_asset_error"):never{
  const error:any=new Error(message);error.status=status;error.code=code;throw error;
}
function sendError(error:any,res:any,next:any){
  if(error?.status) return res.status(error.status).json({message:error.message,code:error.code});
  next(error);
}
function n(v:any){const x=Number(v??0);return Number.isFinite(x)?x:0;}
function money(v:any){return Math.round(n(v)*100)/100;}
function validDate(v:any){return /^\d{4}-\d{2}-\d{2}$/.test(String(v||""));}
function periodStart(v:any){const s=String(v||"");if(!/^\d{4}-\d{2}$/.test(s))fail(400,"Az időszak formátuma YYYY-MM legyen.","invalid_period");return `${s}-01`;}
function isoDate(d:Date){return d.toISOString().slice(0,10);}
function monthEnd(start:string){const d=new Date(`${start}T12:00:00Z`);d.setUTCMonth(d.getUTCMonth()+1);d.setUTCDate(0);return isoDate(d);}
function daysInMonth(start:string){return Number(monthEnd(start).slice(8,10));}
function addFrequency(value:string|Date, amount:number, unit:string){
  const d=new Date(typeof value==="string"?`${value.slice(0,10)}T12:00:00Z`:value);
  const count=Math.max(1,Math.trunc(amount||1));
  if(unit==="day"||unit==="days") d.setUTCDate(d.getUTCDate()+count);
  else if(unit==="week"||unit==="weeks") d.setUTCDate(d.getUTCDate()+7*count);
  else if(unit==="year"||unit==="years") d.setUTCFullYear(d.getUTCFullYear()+count);
  else d.setUTCMonth(d.getUTCMonth()+count);
  return isoDate(d);
}
function randomCode(prefix:string){return `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;}
function requireConfig(req:any){if(!hasRole(req,CONFIG_ROLES))fail(403,"Ehhez a művelethez vezetői vagy könyvelői jogosultság szükséges.","asset_config_forbidden");}

let schemaPromise:Promise<void>|null=null;
export function ensureFixedAssetSchema(){
  if(schemaPromise) return schemaPromise;
  schemaPromise=(async()=>{
    await db.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;

      CREATE TABLE IF NOT EXISTS gl_accounts(
        code text PRIMARY KEY,
        name text NOT NULL,
        account_type text NOT NULL,
        system_key text UNIQUE,
        active boolean NOT NULL DEFAULT true,
        external_account_code text,
        note text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS accounting_periods(
        period_month date PRIMARY KEY,
        status text NOT NULL DEFAULT 'open',
        closed_at timestamptz,
        closed_by text,
        note text,
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS gl_journal_entries(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        journal_no text NOT NULL UNIQUE,
        entry_date date NOT NULL,
        period_month date NOT NULL,
        location_id text,
        source_type text,
        source_id text,
        description text NOT NULL,
        status text NOT NULL DEFAULT 'posted',
        reversal_of_id uuid,
        created_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        posted_by text,
        posted_at timestamptz,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb
      );

      CREATE TABLE IF NOT EXISTS fixed_asset_categories(
        code text PRIMARY KEY,
        name text NOT NULL,
        default_useful_life_months integer,
        default_residual_percent numeric(8,4) NOT NULL DEFAULT 0,
        default_depreciation_method text NOT NULL DEFAULT 'straight_line',
        policy_note text,
        active boolean NOT NULL DEFAULT true,
        sort_order integer NOT NULL DEFAULT 100
      );

      CREATE TABLE IF NOT EXISTS fixed_assets(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        asset_code text NOT NULL UNIQUE,
        source_master_equipment_id text UNIQUE,
        name text NOT NULL,
        category_code text REFERENCES fixed_asset_categories(code),
        manufacturer text,
        model text,
        serial_number text,
        location_id text,
        cost_center text,
        responsible_employee_id text,
        supplier_partner_id text,
        invoice_document_id text,
        purchase_date date,
        commissioned_at date,
        warranty_end date,
        status text NOT NULL DEFAULT 'draft',
        condition text NOT NULL DEFAULT 'good',
        currency text NOT NULL DEFAULT 'HUF',
        acquisition_net numeric(16,2) NOT NULL DEFAULT 0,
        nonrecoverable_vat numeric(16,2) NOT NULL DEFAULT 0,
        freight_cost numeric(16,2) NOT NULL DEFAULT 0,
        installation_cost numeric(16,2) NOT NULL DEFAULT 0,
        other_capital_cost numeric(16,2) NOT NULL DEFAULT 0,
        capitalized_cost numeric(16,2) NOT NULL DEFAULT 0,
        residual_value numeric(16,2) NOT NULL DEFAULT 0,
        useful_life_months integer,
        depreciation_method text NOT NULL DEFAULT 'straight_line',
        book_annual_rate numeric(9,4),
        tax_depreciation_rate numeric(9,4),
        tax_classification text,
        depreciation_policy_status text NOT NULL DEFAULT 'needs_review',
        depreciation_policy_note text,
        gl_asset_account text NOT NULL DEFAULT 'FA-ASSET',
        gl_accumulated_depr_account text NOT NULL DEFAULT 'FA-ACC-DEPR',
        gl_depr_expense_account text NOT NULL DEFAULT 'FA-DEPR-EXP',
        gl_maintenance_expense_account text NOT NULL DEFAULT 'FA-MAINT-EXP',
        gl_counter_account text NOT NULL DEFAULT 'FA-CLEARING',
        gl_disposal_gain_account text NOT NULL DEFAULT 'FA-DISPOSAL-GAIN',
        gl_disposal_loss_account text NOT NULL DEFAULT 'FA-DISPOSAL-LOSS',
        capitalization_journal_id uuid,
        disposed_at date,
        disposal_method text,
        disposal_proceeds numeric(16,2) NOT NULL DEFAULT 0,
        disposal_journal_id uuid,
        note text,
        active boolean NOT NULL DEFAULT true,
        created_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_by text,
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS gl_journal_lines(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        entry_id uuid NOT NULL REFERENCES gl_journal_entries(id) ON DELETE CASCADE,
        line_no integer NOT NULL,
        account_code text NOT NULL REFERENCES gl_accounts(code),
        debit numeric(16,2) NOT NULL DEFAULT 0,
        credit numeric(16,2) NOT NULL DEFAULT 0,
        location_id text,
        cost_center text,
        asset_id uuid REFERENCES fixed_assets(id) ON DELETE SET NULL,
        partner_id text,
        memo text,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(entry_id,line_no)
      );

      CREATE TABLE IF NOT EXISTS fixed_asset_spare_parts(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        asset_id uuid NOT NULL REFERENCES fixed_assets(id) ON DELETE CASCADE,
        inventory_product_id text,
        part_number text,
        name text NOT NULL,
        manufacturer text,
        model text,
        supplier_partner_id text,
        unit text NOT NULL DEFAULT 'db',
        quantity_per_asset numeric(14,3) NOT NULL DEFAULT 1,
        stock_on_hand numeric(14,3) NOT NULL DEFAULT 0,
        min_stock numeric(14,3) NOT NULL DEFAULT 0,
        reorder_point numeric(14,3) NOT NULL DEFAULT 0,
        target_stock numeric(14,3) NOT NULL DEFAULT 0,
        lead_time_days integer NOT NULL DEFAULT 0,
        unit_price numeric(16,2) NOT NULL DEFAULT 0,
        criticality text NOT NULL DEFAULT 'normal',
        replacement_interval_months integer,
        compatibility_note text,
        active boolean NOT NULL DEFAULT true,
        created_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS fixed_asset_maintenance_plans(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        asset_id uuid NOT NULL REFERENCES fixed_assets(id) ON DELETE CASCADE,
        title text NOT NULL,
        maintenance_type text NOT NULL DEFAULT 'preventive',
        trigger_type text NOT NULL DEFAULT 'time',
        frequency_value integer NOT NULL DEFAULT 12,
        frequency_unit text NOT NULL DEFAULT 'month',
        usage_interval numeric(14,2),
        usage_meter_unit text,
        manufacturer_reference text,
        legal_basis text,
        checklist jsonb NOT NULL DEFAULT '[]'::jsonb,
        required_parts jsonb NOT NULL DEFAULT '[]'::jsonb,
        safety_notes text,
        responsible_role text,
        external_supplier_id text,
        estimated_minutes integer NOT NULL DEFAULT 0,
        estimated_cost numeric(16,2) NOT NULL DEFAULT 0,
        last_completed_at date,
        next_due_at date,
        active boolean NOT NULL DEFAULT true,
        created_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS fixed_asset_maintenance_orders(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        order_no text NOT NULL UNIQUE,
        asset_id uuid NOT NULL REFERENCES fixed_assets(id) ON DELETE CASCADE,
        plan_id uuid REFERENCES fixed_asset_maintenance_plans(id) ON DELETE SET NULL,
        maintenance_type text NOT NULL DEFAULT 'preventive',
        status text NOT NULL DEFAULT 'planned',
        scheduled_at date,
        due_at date,
        started_at timestamptz,
        completed_at timestamptz,
        performed_by text,
        approved_by text,
        external_supplier_id text,
        labor_cost numeric(16,2) NOT NULL DEFAULT 0,
        material_cost numeric(16,2) NOT NULL DEFAULT 0,
        external_cost numeric(16,2) NOT NULL DEFAULT 0,
        downtime_minutes integer NOT NULL DEFAULT 0,
        capital_improvement boolean NOT NULL DEFAULT false,
        completion_note text,
        evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
        journal_entry_id uuid,
        financial_posted_at timestamptz,
        created_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS fixed_asset_maintenance_order_parts(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        maintenance_order_id uuid NOT NULL REFERENCES fixed_asset_maintenance_orders(id) ON DELETE CASCADE,
        spare_part_id uuid REFERENCES fixed_asset_spare_parts(id) ON DELETE SET NULL,
        part_name text NOT NULL,
        quantity numeric(14,3) NOT NULL DEFAULT 1,
        unit_price numeric(16,2) NOT NULL DEFAULT 0,
        total_cost numeric(16,2) NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS fixed_asset_depreciation_entries(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        asset_id uuid NOT NULL REFERENCES fixed_assets(id) ON DELETE CASCADE,
        period_month date NOT NULL,
        book_amount numeric(16,2) NOT NULL DEFAULT 0,
        tax_amount numeric(16,2) NOT NULL DEFAULT 0,
        accumulated_book numeric(16,2) NOT NULL DEFAULT 0,
        accumulated_tax numeric(16,2) NOT NULL DEFAULT 0,
        net_book_value numeric(16,2) NOT NULL DEFAULT 0,
        status text NOT NULL DEFAULT 'planned',
        journal_entry_id uuid,
        calculation_note text,
        created_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        posted_at timestamptz,
        UNIQUE(asset_id,period_month)
      );

      CREATE TABLE IF NOT EXISTS fixed_asset_events(
        id bigserial PRIMARY KEY,
        asset_id uuid REFERENCES fixed_assets(id) ON DELETE CASCADE,
        event_type text NOT NULL,
        event_at timestamptz NOT NULL DEFAULT now(),
        actor text,
        data jsonb NOT NULL DEFAULT '{}'::jsonb
      );

      CREATE INDEX IF NOT EXISTS fixed_assets_location_status_idx ON fixed_assets(location_id,status,active,name);
      CREATE INDEX IF NOT EXISTS fixed_asset_parts_asset_idx ON fixed_asset_spare_parts(asset_id,active,criticality);
      CREATE INDEX IF NOT EXISTS fixed_asset_plans_due_idx ON fixed_asset_maintenance_plans(next_due_at,active);
      CREATE INDEX IF NOT EXISTS fixed_asset_orders_due_idx ON fixed_asset_maintenance_orders(due_at,status);
      CREATE INDEX IF NOT EXISTS fixed_asset_depr_period_idx ON fixed_asset_depreciation_entries(period_month,status);
      CREATE INDEX IF NOT EXISTS gl_journal_period_idx ON gl_journal_entries(period_month,status,entry_date);
      CREATE INDEX IF NOT EXISTS gl_lines_account_idx ON gl_journal_lines(account_code,entry_id);
    `);

    await db.query(`
      INSERT INTO gl_accounts(code,name,account_type,system_key,note) VALUES
        ('FA-ASSET','Tárgyi eszközök – belső gyűjtő','asset','fixed_asset_cost','A vállalati számlatükör megfelelő tárgyi eszköz számlájára térképezendő.'),
        ('FA-ACC-DEPR','Tárgyi eszközök halmozott értékcsökkenése','contra_asset','fixed_asset_accumulated_depreciation','A vállalati számlatükör megfelelő halmozott értékcsökkenési számlájára térképezendő.'),
        ('FA-DEPR-EXP','Terv szerinti értékcsökkenés ráfordítása','expense','fixed_asset_depreciation_expense','Könyv szerinti terv szerinti értékcsökkenés eredményszámla.'),
        ('FA-MAINT-EXP','Karbantartási és javítási ráfordítás','expense','fixed_asset_maintenance_expense','Rendszeres karbantartás és javítás.'),
        ('FA-CLEARING','Tárgyi eszköz elszámolási technikai számla','liability','fixed_asset_clearing','Beszerzés, szállító vagy pénzügyi rendezés felé térképezendő technikai ellenszámla.'),
        ('FA-DISPOSAL-GAIN','Tárgyi eszköz kivezetési nyereség','revenue','fixed_asset_disposal_gain','Kivezetési eredmény – nyereség.'),
        ('FA-DISPOSAL-LOSS','Tárgyi eszköz kivezetési veszteség','expense','fixed_asset_disposal_loss','Kivezetési eredmény – veszteség.')
      ON CONFLICT(code) DO UPDATE SET
        name=EXCLUDED.name,account_type=EXCLUDED.account_type,system_key=EXCLUDED.system_key,note=EXCLUDED.note,updated_at=now();

      INSERT INTO fixed_asset_categories(code,name,default_useful_life_months,default_residual_percent,policy_note,sort_order) VALUES
        ('salon_equipment','Szalon gép / kezelőgép',60,0,'Belső tervezési alapérték. Az egyedi hasznos élettartamot és maradványértéket üzembe helyezéskor dokumentáltan jóvá kell hagyni.',10),
        ('it','Informatikai eszköz',36,0,'Belső tervezési alapérték; az egyedi technológiai avulás alapján felülírható.',20),
        ('furniture','Bútor és berendezési tárgy',84,0,'Belső tervezési alapérték; a tényleges várható használat szerint felülírható.',30),
        ('facility','Épületgépészeti / létesítményi eszköz',120,0,'Belső tervezési alapérték; műszaki és számviteli felülvizsgálat szükséges.',40),
        ('other_equipment','Egyéb tárgyi eszköz',60,0,'Belső tervezési alapérték; könyvelői jóváhagyásig csak tervezési adat.',90)
      ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,policy_note=EXCLUDED.policy_note,sort_order=EXCLUDED.sort_order;
    `);

    await db.query(`DO $$ BEGIN
      IF to_regclass('public.master_equipment') IS NOT NULL THEN
        INSERT INTO fixed_assets(
          asset_code,source_master_equipment_id,name,category_code,purchase_date,
          acquisition_net,capitalized_cost,useful_life_months,depreciation_policy_status,status,note,created_by
        )
        SELECT
          COALESCE(NULLIF(to_jsonb(e)->>'item_number',''),'LEGACY') || '-' || right(replace(e.id::text,'-',''),8),
          e.id::text,
          COALESCE(NULLIF(to_jsonb(e)->>'name',''),'Névtelen eszköz'),
          'other_equipment',
          NULLIF(to_jsonb(e)->>'purchase_date','')::date,
          COALESCE(NULLIF(to_jsonb(e)->>'value_amount','')::numeric,0),
          COALESCE(NULLIF(to_jsonb(e)->>'value_amount','')::numeric,0),
          60,
          'needs_review',
          'draft',
          'Automatikusan átvéve a központi eszköztörzsből. Üzembe helyezés és amortizációs politika jóváhagyása szükséges.',
          'masterdata_sync'
        FROM master_equipment e
        WHERE COALESCE(NULLIF(to_jsonb(e)->>'active','')::boolean,true)=true
        ON CONFLICT(source_master_equipment_id) DO UPDATE SET
          name=EXCLUDED.name,
          purchase_date=COALESCE(fixed_assets.purchase_date,EXCLUDED.purchase_date),
          updated_at=now();
      END IF;
    END $$;`);
  })().catch(error=>{schemaPromise=null;throw error;});
  return schemaPromise;
}

async function auditEvent(client:any, assetId:string, type:string, who:string, data:Row={}){
  await client.query(`INSERT INTO fixed_asset_events(asset_id,event_type,actor,data) VALUES($1::uuid,$2,$3,$4::jsonb)`,[assetId,type,who,JSON.stringify(data)]);
}
async function ensureOpenPeriod(client:any,date:string){
  if(!validDate(date)) fail(400,"A könyvelési dátum érvénytelen.","invalid_entry_date");
  const month=`${date.slice(0,7)}-01`;
  await client.query(`INSERT INTO accounting_periods(period_month,status) VALUES($1::date,'open') ON CONFLICT(period_month) DO NOTHING`,[month]);
  const row=(await client.query(`SELECT status FROM accounting_periods WHERE period_month=$1::date`,[month])).rows[0];
  if(row?.status==="closed") fail(409,`A ${month.slice(0,7)} könyvelési időszak lezárt.`,`accounting_period_closed`);
  return month;
}
async function postJournal(client:any,req:any,input:{entry_date:string;location_id?:string|null;source_type:string;source_id?:string|null;description:string;lines:JournalLine[];metadata?:Row}){
  const lines=(input.lines||[]).filter(l=>money(l.debit)>0||money(l.credit)>0);
  if(lines.length<2) fail(400,"A könyvelési tételhez legalább két főkönyvi sor szükséges.","journal_lines_missing");
  const debit=money(lines.reduce((sum,l)=>sum+n(l.debit),0));
  const credit=money(lines.reduce((sum,l)=>sum+n(l.credit),0));
  if(Math.abs(debit-credit)>0.009) fail(400,`A könyvelési tétel nem egyenlegeződik (T ${debit} / K ${credit}).`,`journal_unbalanced`);
  const codes=[...new Set(lines.map(l=>String(l.account_code)))];
  const known=(await client.query(`SELECT code FROM gl_accounts WHERE code=ANY($1::text[]) AND active=true`,[codes])).rows.map((r:any)=>r.code);
  const missing=codes.filter(code=>!known.includes(code));
  if(missing.length) fail(400,`Ismeretlen vagy inaktív főkönyvi számla: ${missing.join(", ")}.`,`gl_account_missing`);
  const month=await ensureOpenPeriod(client,input.entry_date);
  const journalNo=`FA-${input.entry_date.replace(/-/g,"")}-${randomCode("J").slice(2)}`;
  const header=(await client.query(`
    INSERT INTO gl_journal_entries(journal_no,entry_date,period_month,location_id,source_type,source_id,description,status,created_by,posted_by,posted_at,metadata)
    VALUES($1,$2::date,$3::date,$4,$5,$6,$7,'posted',$8,$8,now(),$9::jsonb)
    RETURNING *
  `,[journalNo,input.entry_date,month,input.location_id||null,input.source_type,input.source_id||null,input.description,actor(req),JSON.stringify(input.metadata||{})])).rows[0];
  for(let i=0;i<lines.length;i++){
    const l=lines[i];
    await client.query(`
      INSERT INTO gl_journal_lines(entry_id,line_no,account_code,debit,credit,location_id,cost_center,asset_id,partner_id,memo)
      VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8::uuid,$9,$10)
    `,[header.id,i+1,l.account_code,money(l.debit),money(l.credit),input.location_id||null,l.cost_center||null,l.asset_id||null,l.partner_id||null,l.memo||null]);
  }
  return header;
}
async function getAsset(req:any,id:string,client:any=db){
  const loc=selectedLocation(req);
  if(!globalScope(req)&&!loc) fail(403,"A felhasználóhoz nincs telephely rendelve.");
  const params:any[]=[id];
  let locationSql="";
  if(loc){params.push(loc);locationSql=` AND a.location_id=$2`;}
  const row=(await client.query(`
    SELECT a.*,
      COALESCE(d.accumulated_book,0)::numeric accumulated_book,
      GREATEST(a.capitalized_cost-COALESCE(d.accumulated_book,0),0)::numeric net_book_value
    FROM fixed_assets a
    LEFT JOIN LATERAL(
      SELECT COALESCE(SUM(book_amount) FILTER(WHERE status='posted'),0) accumulated_book
      FROM fixed_asset_depreciation_entries x WHERE x.asset_id=a.id
    ) d ON true
    WHERE a.id=$1::uuid AND a.active=true${locationSql}
  `,params)).rows[0];
  if(!row) fail(404,"A tárgyi eszköz nem található.","asset_not_found");
  return row;
}

router.use(requireAuth);
router.use(async(req:any,res,next)=>{
  try{
    await ensureFixedAssetSchema();
    if(!hasRole(req,VIEW_ROLES)) return res.status(403).json({message:"A tárgyi eszköz modulhoz nincs jogosultsága.",code:"fixed_assets_forbidden"});
    next();
  }catch(error){next(error);}
});

router.get("/dashboard",async(req:any,res,next)=>{
  try{
    const loc=selectedLocation(req);
    if(!globalScope(req)&&!loc) return res.json({});
    const params=loc?[loc]:[];
    const assetScope=loc?`a.active=true AND a.location_id=$1`:`a.active=true`;
    const [totals,maintenance,parts,depreciation]=await Promise.all([
      db.query(`
        SELECT COUNT(*)::int asset_count,
          COUNT(*) FILTER(WHERE a.status='active')::int active_count,
          COALESCE(SUM(a.capitalized_cost),0)::numeric gross_value,
          COALESCE(SUM(COALESCE(d.accumulated,0)),0)::numeric accumulated_depreciation,
          COALESCE(SUM(GREATEST(a.capitalized_cost-COALESCE(d.accumulated,0),0)),0)::numeric net_book_value,
          COUNT(*) FILTER(WHERE a.depreciation_policy_status<>'approved' OR a.commissioned_at IS NULL)::int accounting_incomplete
        FROM fixed_assets a
        LEFT JOIN LATERAL(
          SELECT COALESCE(SUM(book_amount) FILTER(WHERE status='posted'),0) accumulated
          FROM fixed_asset_depreciation_entries x WHERE x.asset_id=a.id
        ) d ON true
        WHERE ${assetScope}
      `,params),
      db.query(`
        SELECT COUNT(*) FILTER(WHERE mp.next_due_at<CURRENT_DATE)::int overdue,
          COUNT(*) FILTER(WHERE mp.next_due_at BETWEEN CURRENT_DATE AND CURRENT_DATE+30)::int due_30_days,
          COALESCE(SUM(mp.estimated_cost) FILTER(WHERE mp.next_due_at<=CURRENT_DATE+30),0)::numeric planned_cost_30_days
        FROM fixed_asset_maintenance_plans mp
        JOIN fixed_assets a ON a.id=mp.asset_id
        WHERE ${assetScope} AND mp.active=true
      `,params),
      db.query(`
        SELECT COUNT(*) FILTER(WHERE sp.criticality='critical')::int critical_parts,
          COUNT(*) FILTER(WHERE sp.stock_on_hand<=sp.reorder_point AND sp.reorder_point>0)::int below_reorder,
          COALESCE(SUM(GREATEST(sp.target_stock-sp.stock_on_hand,0)*sp.unit_price) FILTER(WHERE sp.stock_on_hand<=sp.reorder_point),0)::numeric suggested_reorder_value
        FROM fixed_asset_spare_parts sp
        JOIN fixed_assets a ON a.id=sp.asset_id
        WHERE ${assetScope} AND sp.active=true
      `,params),
      db.query(`
        SELECT COALESCE(SUM(de.book_amount),0)::numeric current_month_book,
          COALESCE(SUM(de.tax_amount),0)::numeric current_month_tax,
          COUNT(*) FILTER(WHERE de.status='planned')::int unposted_count
        FROM fixed_asset_depreciation_entries de
        JOIN fixed_assets a ON a.id=de.asset_id
        WHERE ${assetScope} AND de.period_month=date_trunc('month',CURRENT_DATE)::date
      `,params)
    ]);
    res.json({...(totals.rows[0]||{}),maintenance:maintenance.rows[0]||{},spare_parts:parts.rows[0]||{},depreciation:depreciation.rows[0]||{}});
  }catch(error){next(error);}
});

router.get("/categories",async(_req,res,next)=>{
  try{res.json((await db.query(`SELECT * FROM fixed_asset_categories WHERE active=true ORDER BY sort_order,name`)).rows);}catch(error){next(error);}
});

router.get("/assets",async(req:any,res,next)=>{
  try{
    const loc=selectedLocation(req),q=String(req.query.q||"").trim(),status=String(req.query.status||"").trim();
    if(!globalScope(req)&&!loc) return res.json([]);
    const params:any[]=[];let where=`WHERE a.active=true`;
    if(loc){params.push(loc);where+=` AND a.location_id=$${params.length}`;}
    if(q){params.push(`%${q}%`);where+=` AND (a.asset_code ILIKE $${params.length} OR a.name ILIKE $${params.length} OR COALESCE(a.manufacturer,'') ILIKE $${params.length} OR COALESCE(a.model,'') ILIKE $${params.length} OR COALESCE(a.serial_number,'') ILIKE $${params.length})`;}
    if(status){params.push(status);where+=` AND a.status=$${params.length}`;}
    const rows=(await db.query(`
      SELECT a.*,c.name category_name,
        COALESCE(d.accumulated_book,0)::numeric accumulated_book,
        GREATEST(a.capitalized_cost-COALESCE(d.accumulated_book,0),0)::numeric net_book_value,
        COALESCE(mp.overdue,0)::int maintenance_overdue,
        COALESCE(mp.due_30,0)::int maintenance_due_30
      FROM fixed_assets a
      LEFT JOIN fixed_asset_categories c ON c.code=a.category_code
      LEFT JOIN LATERAL(
        SELECT COALESCE(SUM(book_amount) FILTER(WHERE status='posted'),0) accumulated_book
        FROM fixed_asset_depreciation_entries x WHERE x.asset_id=a.id
      ) d ON true
      LEFT JOIN LATERAL(
        SELECT COUNT(*) FILTER(WHERE next_due_at<CURRENT_DATE) overdue,
               COUNT(*) FILTER(WHERE next_due_at BETWEEN CURRENT_DATE AND CURRENT_DATE+30) due_30
        FROM fixed_asset_maintenance_plans p WHERE p.asset_id=a.id AND p.active=true
      ) mp ON true
      ${where}
      ORDER BY a.asset_code,a.name
    `,params)).rows;
    res.json(rows);
  }catch(error){next(error);}
});

router.get("/assets/:id",async(req:any,res,next)=>{
  try{
    const asset=await getAsset(req,req.params.id);
    const [parts,plans,orders,depreciation,events]=await Promise.all([
      db.query(`SELECT * FROM fixed_asset_spare_parts WHERE asset_id=$1::uuid AND active=true ORDER BY CASE criticality WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,name`,[asset.id]),
      db.query(`SELECT * FROM fixed_asset_maintenance_plans WHERE asset_id=$1::uuid AND active=true ORDER BY next_due_at NULLS LAST,title`,[asset.id]),
      db.query(`SELECT *,(labor_cost+material_cost+external_cost)::numeric total_cost FROM fixed_asset_maintenance_orders WHERE asset_id=$1::uuid ORDER BY COALESCE(due_at,scheduled_at) DESC NULLS LAST,created_at DESC LIMIT 100`,[asset.id]),
      db.query(`SELECT * FROM fixed_asset_depreciation_entries WHERE asset_id=$1::uuid ORDER BY period_month DESC LIMIT 120`,[asset.id]),
      db.query(`SELECT * FROM fixed_asset_events WHERE asset_id=$1::uuid ORDER BY event_at DESC LIMIT 100`,[asset.id])
    ]);
    res.json({...asset,spare_parts:parts.rows,maintenance_plans:plans.rows,maintenance_orders:orders.rows,depreciation:depreciation.rows,events:events.rows});
  }catch(error){sendError(error,res,next);}
});

router.post("/assets",async(req:any,res,next)=>{
  const client=await db.connect();
  try{
    requireConfig(req);
    const name=String(req.body?.name||"").trim();
    if(!name) fail(400,"Az eszköz megnevezése kötelező.");
    const locationId=writeLocation(req);
    const categoryCode=String(req.body?.category_code||"other_equipment");
    const policy=(await client.query(`SELECT * FROM fixed_asset_categories WHERE code=$1 AND active=true`,[categoryCode])).rows[0];
    if(!policy) fail(400,"Ismeretlen eszközkategória.");
    const acquisitionNet=money(req.body?.acquisition_net);
    const nonrecoverableVat=money(req.body?.nonrecoverable_vat);
    const freight=money(req.body?.freight_cost);
    const installation=money(req.body?.installation_cost);
    const other=money(req.body?.other_capital_cost);
    const capitalized=money(acquisitionNet+nonrecoverableVat+freight+installation+other);
    const usefulLife=req.body?.useful_life_months==null?Number(policy.default_useful_life_months||0):Number(req.body.useful_life_months);
    const residual=req.body?.residual_value==null?money(capitalized*n(policy.default_residual_percent)/100):money(req.body.residual_value);
    if(residual<0||residual>capitalized) fail(400,"A maradványérték 0 és a bekerülési érték között lehet.","invalid_residual_value");
    const commissioned=req.body?.commissioned_at||null;
    const assetCode=String(req.body?.asset_code||`FA-${new Date().getFullYear()}-${randomCode("A").slice(2)}`).trim();
    await client.query("BEGIN");
    const row=(await client.query(`
      INSERT INTO fixed_assets(
        asset_code,name,category_code,manufacturer,model,serial_number,location_id,cost_center,responsible_employee_id,supplier_partner_id,invoice_document_id,
        purchase_date,commissioned_at,warranty_end,status,condition,currency,acquisition_net,nonrecoverable_vat,freight_cost,installation_cost,other_capital_cost,
        capitalized_cost,residual_value,useful_life_months,depreciation_method,book_annual_rate,tax_depreciation_rate,tax_classification,depreciation_policy_status,
        depreciation_policy_note,gl_asset_account,gl_accumulated_depr_account,gl_depr_expense_account,gl_maintenance_expense_account,gl_counter_account,note,created_by,updated_by
      ) VALUES(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::date,$13::date,$14::date,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$38
      ) RETURNING *
    `,[
      assetCode,name,categoryCode,req.body?.manufacturer||null,req.body?.model||null,req.body?.serial_number||null,locationId,req.body?.cost_center||null,
      req.body?.responsible_employee_id||null,req.body?.supplier_partner_id||null,req.body?.invoice_document_id||null,req.body?.purchase_date||null,commissioned,
      req.body?.warranty_end||null,String(req.body?.status||(commissioned?"active":"draft")),String(req.body?.condition||"good"),String(req.body?.currency||"HUF"),
      acquisitionNet,nonrecoverableVat,freight,installation,other,capitalized,residual,usefulLife>0?usefulLife:null,
      String(req.body?.depreciation_method||policy.default_depreciation_method||"straight_line"),req.body?.book_annual_rate==null?null:n(req.body.book_annual_rate),
      req.body?.tax_depreciation_rate==null?null:n(req.body.tax_depreciation_rate),req.body?.tax_classification||null,
      String(req.body?.depreciation_policy_status||"needs_review"),req.body?.depreciation_policy_note||null,
      String(req.body?.gl_asset_account||"FA-ASSET"),String(req.body?.gl_accumulated_depr_account||"FA-ACC-DEPR"),String(req.body?.gl_depr_expense_account||"FA-DEPR-EXP"),
      String(req.body?.gl_maintenance_expense_account||"FA-MAINT-EXP"),String(req.body?.gl_counter_account||"FA-CLEARING"),req.body?.note||null,actor(req)
    ])).rows[0];
    await auditEvent(client,row.id,"asset_created",actor(req),{capitalized_cost:capitalized});
    await client.query("COMMIT");
    res.status(201).json(row);
  }catch(error){await client.query("ROLLBACK");sendError(error,res,next);}finally{client.release();}
});

router.patch("/assets/:id",async(req:any,res,next)=>{
  const client=await db.connect();
  try{
    requireConfig(req);
    await client.query("BEGIN");
    const old=await getAsset(req,req.params.id,client);
    const value=(key:string)=>req.body?.[key]===undefined?old[key]:req.body[key];
    const acquisitionNet=money(value("acquisition_net"));
    const nonrecoverableVat=money(value("nonrecoverable_vat"));
    const freight=money(value("freight_cost"));
    const installation=money(value("installation_cost"));
    const other=money(value("other_capital_cost"));
    const capitalized=money(acquisitionNet+nonrecoverableVat+freight+installation+other);
    const residual=money(value("residual_value"));
    if(residual<0||residual>capitalized) fail(400,"A maradványérték 0 és a bekerülési érték között lehet.","invalid_residual_value");
    const row=(await client.query(`
      UPDATE fixed_assets SET
        asset_code=$2,name=$3,category_code=$4,manufacturer=$5,model=$6,serial_number=$7,cost_center=$8,responsible_employee_id=$9,
        supplier_partner_id=$10,invoice_document_id=$11,purchase_date=$12::date,commissioned_at=$13::date,warranty_end=$14::date,status=$15,condition=$16,
        currency=$17,acquisition_net=$18,nonrecoverable_vat=$19,freight_cost=$20,installation_cost=$21,other_capital_cost=$22,capitalized_cost=$23,
        residual_value=$24,useful_life_months=$25,depreciation_method=$26,book_annual_rate=$27,tax_depreciation_rate=$28,tax_classification=$29,
        depreciation_policy_status=$30,depreciation_policy_note=$31,gl_asset_account=$32,gl_accumulated_depr_account=$33,gl_depr_expense_account=$34,
        gl_maintenance_expense_account=$35,gl_counter_account=$36,note=$37,updated_by=$38,updated_at=now()
      WHERE id=$1::uuid RETURNING *
    `,[
      old.id,String(value("asset_code")||old.asset_code),String(value("name")||old.name),String(value("category_code")||"other_equipment"),value("manufacturer")||null,
      value("model")||null,value("serial_number")||null,value("cost_center")||null,value("responsible_employee_id")||null,value("supplier_partner_id")||null,
      value("invoice_document_id")||null,value("purchase_date")||null,value("commissioned_at")||null,value("warranty_end")||null,
      String(value("status")||(value("commissioned_at")?"active":"draft")),String(value("condition")||"good"),String(value("currency")||"HUF"),
      acquisitionNet,nonrecoverableVat,freight,installation,other,capitalized,residual,Number(value("useful_life_months")||0)||null,
      String(value("depreciation_method")||"straight_line"),value("book_annual_rate")==null?null:n(value("book_annual_rate")),
      value("tax_depreciation_rate")==null?null:n(value("tax_depreciation_rate")),value("tax_classification")||null,
      String(value("depreciation_policy_status")||"needs_review"),value("depreciation_policy_note")||null,String(value("gl_asset_account")||"FA-ASSET"),
      String(value("gl_accumulated_depr_account")||"FA-ACC-DEPR"),String(value("gl_depr_expense_account")||"FA-DEPR-EXP"),
      String(value("gl_maintenance_expense_account")||"FA-MAINT-EXP"),String(value("gl_counter_account")||"FA-CLEARING"),value("note")||null,actor(req)
    ])).rows[0];
    await auditEvent(client,row.id,"asset_updated",actor(req),{changed:Object.keys(req.body||{})});
    await client.query("COMMIT");
    res.json(row);
  }catch(error){await client.query("ROLLBACK");sendError(error,res,next);}finally{client.release();}
});

router.get("/spare-parts",async(req:any,res,next)=>{
  try{
    const loc=selectedLocation(req);if(!globalScope(req)&&!loc)return res.json([]);
    const rows=(await db.query(`
      SELECT sp.*,a.asset_code,a.name asset_name,a.location_id,
        (sp.stock_on_hand<=sp.reorder_point AND sp.reorder_point>0) reorder_required
      FROM fixed_asset_spare_parts sp
      JOIN fixed_assets a ON a.id=sp.asset_id
      WHERE sp.active=true AND a.active=true ${loc?"AND a.location_id=$1":""}
      ORDER BY CASE sp.criticality WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,a.asset_code,sp.name
    `,loc?[loc]:[])).rows;
    res.json(rows);
  }catch(error){next(error);}
});

router.post("/assets/:id/spare-parts",async(req:any,res,next)=>{
  try{
    requireConfig(req);
    const asset=await getAsset(req,req.params.id);
    const name=String(req.body?.name||"").trim();if(!name)fail(400,"Az alkatrész megnevezése kötelező.");
    const row=(await db.query(`
      INSERT INTO fixed_asset_spare_parts(
        asset_id,inventory_product_id,part_number,name,manufacturer,model,supplier_partner_id,unit,quantity_per_asset,stock_on_hand,min_stock,reorder_point,
        target_stock,lead_time_days,unit_price,criticality,replacement_interval_months,compatibility_note,created_by
      ) VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *
    `,[asset.id,req.body?.inventory_product_id||null,req.body?.part_number||null,name,req.body?.manufacturer||null,req.body?.model||null,req.body?.supplier_partner_id||null,
      String(req.body?.unit||"db"),n(req.body?.quantity_per_asset||1),n(req.body?.stock_on_hand),n(req.body?.min_stock),n(req.body?.reorder_point),n(req.body?.target_stock),
      Math.max(0,Number(req.body?.lead_time_days||0)),money(req.body?.unit_price),String(req.body?.criticality||"normal"),
      req.body?.replacement_interval_months==null?null:Number(req.body.replacement_interval_months),req.body?.compatibility_note||null,actor(req)])).rows[0];
    res.status(201).json(row);
  }catch(error){sendError(error,res,next);}
});

router.patch("/spare-parts/:id",async(req:any,res,next)=>{
  try{
    requireConfig(req);
    const loc=selectedLocation(req);
    if(!globalScope(req)&&!loc)fail(403,"A felhasználóhoz nincs telephely rendelve.");
    const found=(await db.query(`SELECT sp.id FROM fixed_asset_spare_parts sp JOIN fixed_assets a ON a.id=sp.asset_id WHERE sp.id=$1::uuid ${loc?"AND a.location_id=$2":""}`,[req.params.id,...(loc?[loc]:[])])).rows[0];
    if(!found)fail(404,"Az alkatrész nem található.");
    const row=(await db.query(`
      UPDATE fixed_asset_spare_parts SET
        stock_on_hand=COALESCE($2,stock_on_hand),min_stock=COALESCE($3,min_stock),reorder_point=COALESCE($4,reorder_point),target_stock=COALESCE($5,target_stock),
        lead_time_days=COALESCE($6,lead_time_days),unit_price=COALESCE($7,unit_price),criticality=COALESCE(NULLIF($8,''),criticality),
        compatibility_note=COALESCE($9,compatibility_note),updated_at=now()
      WHERE id=$1::uuid RETURNING *
    `,[req.params.id,req.body?.stock_on_hand==null?null:n(req.body.stock_on_hand),req.body?.min_stock==null?null:n(req.body.min_stock),
      req.body?.reorder_point==null?null:n(req.body.reorder_point),req.body?.target_stock==null?null:n(req.body.target_stock),
      req.body?.lead_time_days==null?null:Number(req.body.lead_time_days),req.body?.unit_price==null?null:money(req.body.unit_price),
      String(req.body?.criticality||""),req.body?.compatibility_note??null])).rows[0];
    res.json(row);
  }catch(error){sendError(error,res,next);}
});

router.get("/maintenance/plans",async(req:any,res,next)=>{
  try{
    const loc=selectedLocation(req);if(!globalScope(req)&&!loc)return res.json([]);
    res.json((await db.query(`
      SELECT mp.*,a.asset_code,a.name asset_name,a.location_id,
        CASE WHEN mp.next_due_at<CURRENT_DATE THEN 'overdue' WHEN mp.next_due_at<=CURRENT_DATE+30 THEN 'due' ELSE 'planned' END due_state
      FROM fixed_asset_maintenance_plans mp
      JOIN fixed_assets a ON a.id=mp.asset_id
      WHERE mp.active=true AND a.active=true ${loc?"AND a.location_id=$1":""}
      ORDER BY mp.next_due_at NULLS LAST,a.asset_code,mp.title
    `,loc?[loc]:[])).rows);
  }catch(error){next(error);}
});

router.get("/maintenance/orders",async(req:any,res,next)=>{
  try{
    const loc=selectedLocation(req);if(!globalScope(req)&&!loc)return res.json([]);
    res.json((await db.query(`
      SELECT mo.*,a.asset_code,a.name asset_name,a.location_id,(mo.labor_cost+mo.material_cost+mo.external_cost)::numeric total_cost
      FROM fixed_asset_maintenance_orders mo
      JOIN fixed_assets a ON a.id=mo.asset_id
      WHERE a.active=true ${loc?"AND a.location_id=$1":""}
      ORDER BY COALESCE(mo.due_at,mo.scheduled_at) DESC NULLS LAST,mo.created_at DESC LIMIT 500
    `,loc?[loc]:[])).rows);
  }catch(error){next(error);}
});

router.post("/assets/:id/maintenance-plans",async(req:any,res,next)=>{
  try{
    requireConfig(req);
    const asset=await getAsset(req,req.params.id);
    const title=String(req.body?.title||"").trim();if(!title)fail(400,"A karbantartási feladat neve kötelező.");
    const frequency=Math.max(1,Number(req.body?.frequency_value||12));
    const unit=String(req.body?.frequency_unit||"month");
    const base=String(req.body?.last_completed_at||asset.commissioned_at||new Date().toISOString().slice(0,10));
    const nextDue=req.body?.next_due_at||addFrequency(base,frequency,unit);
    const row=(await db.query(`
      INSERT INTO fixed_asset_maintenance_plans(
        asset_id,title,maintenance_type,trigger_type,frequency_value,frequency_unit,usage_interval,usage_meter_unit,manufacturer_reference,legal_basis,
        checklist,required_parts,safety_notes,responsible_role,external_supplier_id,estimated_minutes,estimated_cost,last_completed_at,next_due_at,created_by
      ) VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17,$18::date,$19::date,$20) RETURNING *
    `,[asset.id,title,String(req.body?.maintenance_type||"preventive"),String(req.body?.trigger_type||"time"),frequency,unit,
      req.body?.usage_interval==null?null:n(req.body.usage_interval),req.body?.usage_meter_unit||null,req.body?.manufacturer_reference||null,req.body?.legal_basis||null,
      JSON.stringify(req.body?.checklist||[]),JSON.stringify(req.body?.required_parts||[]),req.body?.safety_notes||null,req.body?.responsible_role||null,
      req.body?.external_supplier_id||null,Number(req.body?.estimated_minutes||0),money(req.body?.estimated_cost),req.body?.last_completed_at||null,nextDue,actor(req)])).rows[0];
    res.status(201).json(row);
  }catch(error){sendError(error,res,next);}
});

router.patch("/maintenance/plans/:id",async(req:any,res,next)=>{
  try{
    requireConfig(req);
    const loc=selectedLocation(req);if(!globalScope(req)&&!loc)fail(403,"A felhasználóhoz nincs telephely rendelve.");
    const found=(await db.query(`SELECT mp.id FROM fixed_asset_maintenance_plans mp JOIN fixed_assets a ON a.id=mp.asset_id WHERE mp.id=$1::uuid ${loc?"AND a.location_id=$2":""}`,[req.params.id,...(loc?[loc]:[])])).rows[0];
    if(!found)fail(404,"A karbantartási terv nem található.");
    const row=(await db.query(`
      UPDATE fixed_asset_maintenance_plans SET
        title=COALESCE(NULLIF($2,''),title),frequency_value=COALESCE($3,frequency_value),frequency_unit=COALESCE(NULLIF($4,''),frequency_unit),
        manufacturer_reference=COALESCE($5,manufacturer_reference),legal_basis=COALESCE($6,legal_basis),checklist=COALESCE($7::jsonb,checklist),
        required_parts=COALESCE($8::jsonb,required_parts),safety_notes=COALESCE($9,safety_notes),responsible_role=COALESCE($10,responsible_role),
        estimated_minutes=COALESCE($11,estimated_minutes),estimated_cost=COALESCE($12,estimated_cost),next_due_at=COALESCE($13::date,next_due_at),
        active=COALESCE($14,active),updated_at=now()
      WHERE id=$1::uuid RETURNING *
    `,[req.params.id,String(req.body?.title||""),req.body?.frequency_value==null?null:Number(req.body.frequency_value),String(req.body?.frequency_unit||""),
      req.body?.manufacturer_reference??null,req.body?.legal_basis??null,req.body?.checklist===undefined?null:JSON.stringify(req.body.checklist),
      req.body?.required_parts===undefined?null:JSON.stringify(req.body.required_parts),req.body?.safety_notes??null,req.body?.responsible_role??null,
      req.body?.estimated_minutes==null?null:Number(req.body.estimated_minutes),req.body?.estimated_cost==null?null:money(req.body.estimated_cost),
      req.body?.next_due_at||null,req.body?.active==null?null:Boolean(req.body.active)])).rows[0];
    res.json(row);
  }catch(error){sendError(error,res,next);}
});

router.post("/maintenance/orders",async(req:any,res,next)=>{
  try{
    requireConfig(req);
    const asset=await getAsset(req,String(req.body?.asset_id||""));
    const orderNo=`KARB-${new Date().getFullYear()}-${randomCode("M").slice(2)}`;
    const row=(await db.query(`
      INSERT INTO fixed_asset_maintenance_orders(order_no,asset_id,plan_id,maintenance_type,status,scheduled_at,due_at,external_supplier_id,created_by)
      VALUES($1,$2::uuid,$3::uuid,$4,'planned',$5::date,$6::date,$7,$8) RETURNING *
    `,[orderNo,asset.id,req.body?.plan_id||null,String(req.body?.maintenance_type||"preventive"),req.body?.scheduled_at||null,req.body?.due_at||null,req.body?.external_supplier_id||null,actor(req)])).rows[0];
    res.status(201).json(row);
  }catch(error){sendError(error,res,next);}
});

router.post("/maintenance/orders/:id/complete",async(req:any,res,next)=>{
  const client=await db.connect();
  try{
    requireConfig(req);
    await client.query("BEGIN");
    const loc=selectedLocation(req);if(!globalScope(req)&&!loc)fail(403,"A felhasználóhoz nincs telephely rendelve.");
    const params:any[]=[req.params.id];let locationSql="";if(loc){params.push(loc);locationSql=` AND a.location_id=$2`;}
    const order=(await client.query(`
      SELECT mo.*,a.location_id,a.cost_center,a.gl_asset_account,a.gl_maintenance_expense_account,a.gl_counter_account,a.id asset_id
      FROM fixed_asset_maintenance_orders mo
      JOIN fixed_assets a ON a.id=mo.asset_id
      WHERE mo.id=$1::uuid${locationSql} FOR UPDATE
    `,params)).rows[0];
    if(!order)fail(404,"A karbantartási munkalap nem található.");
    if(order.status==="completed")fail(409,"A karbantartási munkalap már lezárt.");

    const parts=Array.isArray(req.body?.parts)?req.body.parts:[];
    let material=money(req.body?.material_cost);
    for(const part of parts){
      const qty=Math.max(n(part.quantity||1),0),price=money(part.unit_price),total=money(qty*price);
      material=money(material+total);
      await client.query(`
        INSERT INTO fixed_asset_maintenance_order_parts(maintenance_order_id,spare_part_id,part_name,quantity,unit_price,total_cost)
        VALUES($1::uuid,$2::uuid,$3,$4,$5,$6)
      `,[order.id,part.spare_part_id||null,String(part.part_name||"Alkatrész"),qty,price,total]);
      if(part.spare_part_id){
        const stock=(await client.query(`SELECT stock_on_hand FROM fixed_asset_spare_parts WHERE id=$1::uuid AND asset_id=$2::uuid FOR UPDATE`,[part.spare_part_id,order.asset_id])).rows[0];
        if(!stock)fail(400,"A megadott cserealkatrész nem ehhez az eszközhöz tartozik.","spare_part_asset_mismatch");
        if(n(stock.stock_on_hand)<qty)fail(409,"Nincs elegendő cserealkatrész készleten.","spare_part_stock_shortage");
        await client.query(`UPDATE fixed_asset_spare_parts SET stock_on_hand=stock_on_hand-$2,updated_at=now() WHERE id=$1::uuid`,[part.spare_part_id,qty]);
      }
    }

    const labor=money(req.body?.labor_cost),external=money(req.body?.external_cost),total=money(labor+material+external);
    const capitalImprovement=Boolean(req.body?.capital_improvement);
    const completed=String(req.body?.completed_at||new Date().toISOString().slice(0,10));
    if(!validDate(completed))fail(400,"A lezárás dátuma érvénytelen.","invalid_completion_date");
    let journal:any=null;
    if(total>0&&req.body?.post_to_accounting!==false){
      journal=await postJournal(client,req,{
        entry_date:completed,location_id:order.location_id,
        source_type:capitalImprovement?"fixed_asset_improvement":"fixed_asset_maintenance",source_id:order.id,
        description:`${order.order_no} – ${capitalImprovement?"aktiválandó felújítás / értéknövelés":"karbantartás és javítás"}`,
        lines:[
          {account_code:capitalImprovement?order.gl_asset_account:order.gl_maintenance_expense_account,debit:total,asset_id:order.asset_id,cost_center:order.cost_center},
          {account_code:order.gl_counter_account,credit:total,asset_id:order.asset_id,cost_center:order.cost_center}
        ]
      });
      if(capitalImprovement){
        await client.query(`UPDATE fixed_assets SET capitalized_cost=capitalized_cost+$2,other_capital_cost=other_capital_cost+$2,updated_at=now() WHERE id=$1::uuid`,[order.asset_id,total]);
      }
    }

    const updated=(await client.query(`
      UPDATE fixed_asset_maintenance_orders SET
        status='completed',completed_at=$2::date,performed_by=$3,approved_by=$4,labor_cost=$5,material_cost=$6,external_cost=$7,
        downtime_minutes=$8,capital_improvement=$9,completion_note=$10,evidence=$11::jsonb,journal_entry_id=$12::uuid,
        financial_posted_at=CASE WHEN $12::uuid IS NULL THEN NULL ELSE now() END,updated_at=now()
      WHERE id=$1::uuid RETURNING *
    `,[order.id,completed,req.body?.performed_by||actor(req),req.body?.approved_by||actor(req),labor,material,external,Number(req.body?.downtime_minutes||0),
      capitalImprovement,req.body?.completion_note||null,JSON.stringify(req.body?.evidence||[]),journal?.id||null])).rows[0];

    if(order.plan_id){
      const plan=(await client.query(`SELECT * FROM fixed_asset_maintenance_plans WHERE id=$1::uuid`,[order.plan_id])).rows[0];
      if(plan){
        await client.query(`UPDATE fixed_asset_maintenance_plans SET last_completed_at=$2::date,next_due_at=$3::date,updated_at=now() WHERE id=$1::uuid`,
          [plan.id,completed,addFrequency(completed,Number(plan.frequency_value||1),String(plan.frequency_unit||"month"))]);
      }
    }
    await auditEvent(client,order.asset_id,"maintenance_completed",actor(req),{order_id:order.id,total_cost:total,capital_improvement:capitalImprovement,journal_entry_id:journal?.id||null});
    await client.query("COMMIT");
    res.json({...updated,total_cost:total,journal_entry:journal});
  }catch(error){await client.query("ROLLBACK");sendError(error,res,next);}finally{client.release();}
});

router.get("/depreciation",async(req:any,res,next)=>{
  try{
    const loc=selectedLocation(req),period=String(req.query.period||new Date().toISOString().slice(0,7));
    const start=periodStart(period);if(!globalScope(req)&&!loc)return res.json([]);
    res.json((await db.query(`
      SELECT de.*,a.asset_code,a.name asset_name,a.location_id,a.capitalized_cost,a.residual_value,a.useful_life_months,a.tax_depreciation_rate
      FROM fixed_asset_depreciation_entries de
      JOIN fixed_assets a ON a.id=de.asset_id
      WHERE de.period_month=$1::date ${loc?"AND a.location_id=$2":""}
      ORDER BY a.asset_code
    `,[start,...(loc?[loc]:[])])).rows);
  }catch(error){sendError(error,res,next);}
});

router.post("/depreciation/run",async(req:any,res,next)=>{
  const client=await db.connect();
  try{
    requireConfig(req);
    const period=String(req.body?.period||new Date().toISOString().slice(0,7));
    const start=periodStart(period),end=monthEnd(start),days=daysInMonth(start);
    const locationId=selectedLocation(req);
    if(!globalScope(req)&&!locationId)fail(403,"A felhasználóhoz nincs telephely rendelve.");
    await client.query("BEGIN");
    await ensureOpenPeriod(client,start);

    const assetParams:any[]=[end,start];
    let assetSql=`
      SELECT * FROM fixed_assets
      WHERE active=true
        AND commissioned_at IS NOT NULL
        AND commissioned_at<=$1::date
        AND status NOT IN('draft','scrapped','sold')
        AND COALESCE(useful_life_months,0)>0
        AND depreciation_policy_status='approved'
        AND (disposed_at IS NULL OR disposed_at>=$2::date)
    `;
    if(locationId){assetParams.push(locationId);assetSql+=` AND location_id=$3`;}
    assetSql+=` ORDER BY asset_code`;
    const assets=(await client.query(assetSql,assetParams)).rows;
    const result:any[]=[];

    for(const asset of assets){
      const existing=(await client.query(`SELECT * FROM fixed_asset_depreciation_entries WHERE asset_id=$1::uuid AND period_month=$2::date FOR UPDATE`,[asset.id,start])).rows[0];
      if(existing?.status==="posted"){result.push({...existing,asset_code:asset.asset_code,asset_name:asset.name});continue;}

      const prior=(await client.query(`
        SELECT COALESCE(SUM(book_amount),0)::numeric book,
               COALESCE(SUM(tax_amount),0)::numeric tax,
               COUNT(*) FILTER(WHERE book_amount>0)::int periods
        FROM fixed_asset_depreciation_entries
        WHERE asset_id=$1::uuid AND period_month<$2::date
      `,[asset.id,start])).rows[0];

      const depreciableBasis=Math.max(money(n(asset.capitalized_cost)-n(asset.residual_value)),0);
      const bookBefore=money(prior.book);
      const remainingBook=Math.max(money(depreciableBasis-bookBefore),0);
      const lifeMonths=Math.max(Number(asset.useful_life_months||0),1);
      const elapsedPeriods=Math.max(Number(prior.periods||0),0);
      const remainingPeriods=Math.max(lifeMonths-elapsedPeriods,1);
      let factor=1;
      const commissioned=String(asset.commissioned_at).slice(0,10);
      if(commissioned>=start&&commissioned<=end){const day=Number(commissioned.slice(8,10));factor=Math.max(0,(days-day+1)/days);}
      if(asset.disposed_at){const disposed=String(asset.disposed_at).slice(0,10);if(disposed>=start&&disposed<=end){const day=Number(disposed.slice(8,10));factor=Math.min(factor,Math.max(0,day/days));}}

      let bookAmount=money(Math.min(remainingBook,(depreciableBasis/lifeMonths)*factor));
      if(asset.depreciation_method==="declining_balance"&&n(asset.book_annual_rate)>0){
        bookAmount=money(Math.min(remainingBook,(n(asset.capitalized_cost)-bookBefore)*n(asset.book_annual_rate)/100/12*factor));
      }else if(elapsedPeriods>=lifeMonths-1){
        bookAmount=money(remainingBook);
      }

      const taxBefore=money(prior.tax),taxRate=n(asset.tax_depreciation_rate),taxRemaining=Math.max(money(n(asset.capitalized_cost)-taxBefore),0);
      const taxAmount=money(taxRate>0?Math.min(taxRemaining,n(asset.capitalized_cost)*taxRate/100/12*factor):0);
      const accumulatedBook=money(bookBefore+bookAmount),accumulatedTax=money(taxBefore+taxAmount);
      const netBookValue=money(Math.max(n(asset.capitalized_cost)-accumulatedBook,n(asset.residual_value)));
      const calculationNote=`${asset.depreciation_method}; hasznos élettartam ${lifeMonths} hó; havi időarány ${Math.round(factor*10000)/100}%; TAO-kulcs külön nyilvántartva.`;

      const row=(await client.query(`
        INSERT INTO fixed_asset_depreciation_entries(asset_id,period_month,book_amount,tax_amount,accumulated_book,accumulated_tax,net_book_value,status,calculation_note,created_by)
        VALUES($1::uuid,$2::date,$3,$4,$5,$6,$7,'planned',$8,$9)
        ON CONFLICT(asset_id,period_month) DO UPDATE SET
          book_amount=CASE WHEN fixed_asset_depreciation_entries.status='posted' THEN fixed_asset_depreciation_entries.book_amount ELSE EXCLUDED.book_amount END,
          tax_amount=CASE WHEN fixed_asset_depreciation_entries.status='posted' THEN fixed_asset_depreciation_entries.tax_amount ELSE EXCLUDED.tax_amount END,
          accumulated_book=CASE WHEN fixed_asset_depreciation_entries.status='posted' THEN fixed_asset_depreciation_entries.accumulated_book ELSE EXCLUDED.accumulated_book END,
          accumulated_tax=CASE WHEN fixed_asset_depreciation_entries.status='posted' THEN fixed_asset_depreciation_entries.accumulated_tax ELSE EXCLUDED.accumulated_tax END,
          net_book_value=CASE WHEN fixed_asset_depreciation_entries.status='posted' THEN fixed_asset_depreciation_entries.net_book_value ELSE EXCLUDED.net_book_value END,
          calculation_note=EXCLUDED.calculation_note
        RETURNING *
      `,[asset.id,start,bookAmount,taxAmount,accumulatedBook,accumulatedTax,netBookValue,calculationNote,actor(req)])).rows[0];

      if(Boolean(req.body?.post)&&row.status!=="posted"&&bookAmount>0){
        const journal=await postJournal(client,req,{
          entry_date:end,location_id:asset.location_id,source_type:"fixed_asset_depreciation",source_id:row.id,
          description:`${asset.asset_code} – ${period} terv szerinti értékcsökkenés`,
          lines:[
            {account_code:asset.gl_depr_expense_account,debit:bookAmount,asset_id:asset.id,cost_center:asset.cost_center},
            {account_code:asset.gl_accumulated_depr_account,credit:bookAmount,asset_id:asset.id,cost_center:asset.cost_center}
          ],metadata:{tax_depreciation:taxAmount,tax_rate:taxRate}
        });
        const posted=(await client.query(`UPDATE fixed_asset_depreciation_entries SET status='posted',journal_entry_id=$2::uuid,posted_at=now() WHERE id=$1::uuid RETURNING *`,[row.id,journal.id])).rows[0];
        await auditEvent(client,asset.id,"depreciation_posted",actor(req),{period,book_amount:bookAmount,tax_amount:taxAmount,journal_entry_id:journal.id});
        result.push({...posted,asset_code:asset.asset_code,asset_name:asset.name});
      }else result.push({...row,asset_code:asset.asset_code,asset_name:asset.name});
    }

    await client.query("COMMIT");
    res.json({period,post:Boolean(req.body?.post),count:result.length,rows:result});
  }catch(error){await client.query("ROLLBACK");sendError(error,res,next);}finally{client.release();}
});

router.post("/assets/:id/capitalization/post",async(req:any,res,next)=>{
  const client=await db.connect();
  try{
    requireConfig(req);await client.query("BEGIN");
    const asset=await getAsset(req,req.params.id,client);
    if(!asset.commissioned_at)fail(409,"Az eszköz üzembe helyezési dátuma nélkül nem aktiválható.","commissioning_required");
    if(asset.depreciation_policy_status!=="approved")fail(409,"Az amortizációs politikát jóvá kell hagyni az aktiválás előtt.","depreciation_policy_approval_required");
    if(asset.capitalization_journal_id){await client.query("ROLLBACK");return res.json({already_posted:true,journal_entry_id:asset.capitalization_journal_id});}
    const amount=money(asset.capitalized_cost);if(!(amount>0))fail(400,"A bekerülési érték nem lehet nulla.");
    const entry=await postJournal(client,req,{
      entry_date:String(asset.commissioned_at).slice(0,10),location_id:asset.location_id,source_type:"fixed_asset_capitalization",source_id:asset.id,
      description:`${asset.asset_code} – ${asset.name} aktiválása`,
      lines:[
        {account_code:asset.gl_asset_account,debit:amount,asset_id:asset.id,cost_center:asset.cost_center},
        {account_code:asset.gl_counter_account,credit:amount,asset_id:asset.id,cost_center:asset.cost_center,partner_id:asset.supplier_partner_id}
      ]
    });
    await client.query(`UPDATE fixed_assets SET capitalization_journal_id=$2::uuid,status=CASE WHEN status='draft' THEN 'active' ELSE status END,updated_at=now() WHERE id=$1::uuid`,[asset.id,entry.id]);
    await auditEvent(client,asset.id,"capitalization_posted",actor(req),{amount,journal_entry_id:entry.id});
    await client.query("COMMIT");res.json(entry);
  }catch(error){await client.query("ROLLBACK");sendError(error,res,next);}finally{client.release();}
});

router.post("/assets/:id/dispose",async(req:any,res,next)=>{
  const client=await db.connect();
  try{
    requireConfig(req);await client.query("BEGIN");
    const asset=await getAsset(req,req.params.id,client);
    if(asset.disposed_at)fail(409,"Az eszköz már kivezetésre került.");
    const disposalDate=String(req.body?.disposed_at||new Date().toISOString().slice(0,10));if(!validDate(disposalDate))fail(400,"A kivezetés dátuma érvénytelen.");
    const proceeds=money(req.body?.proceeds);
    const accumulated=money((await client.query(`SELECT COALESCE(SUM(book_amount),0) amount FROM fixed_asset_depreciation_entries WHERE asset_id=$1::uuid AND status='posted'`,[asset.id])).rows[0]?.amount);
    const gross=money(asset.capitalized_cost),netBookValue=Math.max(money(gross-accumulated),0),result=money(proceeds-netBookValue);
    const lines:JournalLine[]=[
      {account_code:asset.gl_accumulated_depr_account,debit:accumulated,asset_id:asset.id,cost_center:asset.cost_center},
      {account_code:asset.gl_asset_account,credit:gross,asset_id:asset.id,cost_center:asset.cost_center}
    ];
    if(proceeds>0)lines.push({account_code:asset.gl_counter_account,debit:proceeds,asset_id:asset.id,cost_center:asset.cost_center});
    if(result>0)lines.push({account_code:asset.gl_disposal_gain_account,credit:result,asset_id:asset.id,cost_center:asset.cost_center});
    if(result<0)lines.push({account_code:asset.gl_disposal_loss_account,debit:Math.abs(result),asset_id:asset.id,cost_center:asset.cost_center});
    const entry=await postJournal(client,req,{
      entry_date:disposalDate,location_id:asset.location_id,source_type:"fixed_asset_disposal",source_id:asset.id,
      description:`${asset.asset_code} – tárgyi eszköz kivezetése`,lines,
      metadata:{gross,accumulated_depreciation:accumulated,net_book_value:netBookValue,proceeds,method:req.body?.method||"retired"}
    });
    await client.query(`UPDATE fixed_assets SET status=$2,disposed_at=$3::date,disposal_method=$4,disposal_proceeds=$5,disposal_journal_id=$6::uuid,updated_at=now() WHERE id=$1::uuid`,
      [asset.id,String(req.body?.status||"disposed"),disposalDate,String(req.body?.method||"retired"),proceeds,entry.id]);
    await auditEvent(client,asset.id,"asset_disposed",actor(req),{net_book_value:netBookValue,proceeds,result,journal_entry_id:entry.id});
    await client.query("COMMIT");res.json({journal_entry:entry,net_book_value:netBookValue,proceeds,result});
  }catch(error){await client.query("ROLLBACK");sendError(error,res,next);}finally{client.release();}
});

router.get("/accounting/chart",async(_req,res,next)=>{
  try{res.json((await db.query(`SELECT * FROM gl_accounts WHERE active=true ORDER BY code`)).rows);}catch(error){next(error);}
});

router.put("/accounting/chart/:code",async(req:any,res,next)=>{
  try{
    requireConfig(req);
    const code=String(req.params.code||"").trim();if(!code)fail(400,"A főkönyvi számlakód kötelező.");
    const row=(await db.query(`
      INSERT INTO gl_accounts(code,name,account_type,external_account_code,note,active)
      VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,account_type=EXCLUDED.account_type,external_account_code=EXCLUDED.external_account_code,
        note=EXCLUDED.note,active=EXCLUDED.active,updated_at=now()
      RETURNING *
    `,[code,String(req.body?.name||code),String(req.body?.account_type||"asset"),req.body?.external_account_code||null,req.body?.note||null,req.body?.active!==false])).rows[0];
    res.json(row);
  }catch(error){sendError(error,res,next);}
});

router.get("/accounting/journal",async(req:any,res,next)=>{
  try{
    const loc=selectedLocation(req),from=String(req.query.from||""),to=String(req.query.to||"");if(!globalScope(req)&&!loc)return res.json([]);
    const params:any[]=[];let where=`WHERE e.status='posted'`;
    if(loc){params.push(loc);where+=` AND e.location_id=$${params.length}`;}
    if(from){params.push(from);where+=` AND e.entry_date>=$${params.length}::date`;}
    if(to){params.push(to);where+=` AND e.entry_date<=$${params.length}::date`;}
    res.json((await db.query(`
      SELECT e.*,COALESCE(json_agg(json_build_object('line_no',l.line_no,'account_code',l.account_code,'account_name',a.name,'debit',l.debit,'credit',l.credit,'cost_center',l.cost_center,'asset_id',l.asset_id,'memo',l.memo) ORDER BY l.line_no) FILTER(WHERE l.id IS NOT NULL),'[]') lines
      FROM gl_journal_entries e
      LEFT JOIN gl_journal_lines l ON l.entry_id=e.id
      LEFT JOIN gl_accounts a ON a.code=l.account_code
      ${where}
      GROUP BY e.id ORDER BY e.entry_date DESC,e.created_at DESC LIMIT 1000
    `,params)).rows);
  }catch(error){next(error);}
});

router.get("/accounting/trial-balance",async(req:any,res,next)=>{
  try{
    const loc=selectedLocation(req),from=String(req.query.from||""),to=String(req.query.to||"");if(!globalScope(req)&&!loc)return res.json([]);
    const params:any[]=[];let conditions=`e.status='posted'`;
    if(loc){params.push(loc);conditions+=` AND e.location_id=$${params.length}`;}
    if(from){params.push(from);conditions+=` AND e.entry_date>=$${params.length}::date`;}
    if(to){params.push(to);conditions+=` AND e.entry_date<=$${params.length}::date`;}
    res.json((await db.query(`
      SELECT a.code,a.name,a.account_type,
        COALESCE(SUM(CASE WHEN ${conditions} THEN l.debit ELSE 0 END),0)::numeric debit,
        COALESCE(SUM(CASE WHEN ${conditions} THEN l.credit ELSE 0 END),0)::numeric credit,
        COALESCE(SUM(CASE WHEN ${conditions} THEN l.debit-l.credit ELSE 0 END),0)::numeric balance
      FROM gl_accounts a
      LEFT JOIN gl_journal_lines l ON l.account_code=a.code
      LEFT JOIN gl_journal_entries e ON e.id=l.entry_id
      WHERE a.active=true
      GROUP BY a.code,a.name,a.account_type ORDER BY a.code
    `,params)).rows);
  }catch(error){next(error);}
});

router.post("/accounting/journal",async(req:any,res,next)=>{
  const client=await db.connect();
  try{
    requireConfig(req);await client.query("BEGIN");
    const locationId=writeLocation(req);
    const entry=await postJournal(client,req,{
      entry_date:String(req.body?.entry_date||new Date().toISOString().slice(0,10)),location_id:locationId,
      source_type:String(req.body?.source_type||"manual"),source_id:req.body?.source_id||null,
      description:String(req.body?.description||"Vegyes könyvelési tétel"),lines:Array.isArray(req.body?.lines)?req.body.lines:[],metadata:req.body?.metadata||{}
    });
    await client.query("COMMIT");res.status(201).json(entry);
  }catch(error){await client.query("ROLLBACK");sendError(error,res,next);}finally{client.release();}
});

router.get("/accounting/periods",async(_req,res,next)=>{
  try{res.json((await db.query(`SELECT * FROM accounting_periods ORDER BY period_month DESC LIMIT 60`)).rows);}catch(error){next(error);}
});

router.post("/accounting/periods/:period/close",async(req:any,res,next)=>{
  try{
    requireConfig(req);const month=periodStart(req.params.period);
    const unposted=(await db.query(`SELECT COUNT(*)::int count FROM fixed_asset_depreciation_entries WHERE period_month=$1::date AND status='planned'`,[month])).rows[0]?.count||0;
    if(unposted>0&&!Boolean(req.body?.force))fail(409,`Az időszakban ${unposted} nem könyvelt értékcsökkenési tétel van.`,`unposted_depreciation_exists`);
    const row=(await db.query(`
      INSERT INTO accounting_periods(period_month,status,closed_at,closed_by,note)
      VALUES($1::date,'closed',now(),$2,$3)
      ON CONFLICT(period_month) DO UPDATE SET status='closed',closed_at=now(),closed_by=EXCLUDED.closed_by,note=EXCLUDED.note,updated_at=now()
      RETURNING *
    `,[month,actor(req),req.body?.note||null])).rows[0];
    res.json(row);
  }catch(error){sendError(error,res,next);}
});

router.post("/accounting/periods/:period/reopen",async(req:any,res,next)=>{
  try{
    if(!roleList(req.user?.role).some(r=>["admin","administrator","rendszergazda","superadmin","super_admin"].includes(r)))fail(403,"Lezárt időszakot csak rendszergazda nyithat újra.");
    const month=periodStart(req.params.period);
    res.json((await db.query(`
      INSERT INTO accounting_periods(period_month,status) VALUES($1::date,'open')
      ON CONFLICT(period_month) DO UPDATE SET status='open',closed_at=NULL,closed_by=NULL,updated_at=now() RETURNING *
    `,[month])).rows[0]);
  }catch(error){sendError(error,res,next);}
});

export default router;
