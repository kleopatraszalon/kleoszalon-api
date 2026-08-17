// backend/src/routes/timetable.ts
import express from "express";
import pool from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { ensureHrV2 } from "../hr/ensureHrV2";

const router = express.Router();
router.use(requireAuth);

const asyncRoute = (handler: (req: AuthRequest, res: express.Response) => Promise<any>) =>
  (req: AuthRequest, res: express.Response, next: express.NextFunction) => handler(req, res).catch(next);
const int = (value: any, fallback = 0) => Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback;
const actor = (req: AuthRequest) => String(req.user?.id ?? "");

function legalWarnings(shifts: any[], profiles: Map<string, any>, holidays: Set<string>) {
  const warnings: any[] = [];
  const byEmployee = new Map<string, any[]>();
  for (const shift of shifts) {
    const list = byEmployee.get(String(shift.employee_id)) || [];
    list.push(shift); byEmployee.set(String(shift.employee_id), list);
  }
  for (const [employeeId, items] of byEmployee) {
    const profile = profiles.get(employeeId) || {};
    items.sort((a,b)=>+new Date(a.starts_at)-+new Date(b.starts_at));
    let weekly = 0;
    items.forEach((shift,index) => {
      if (shift.status === "cancelled") return;
      const gross = Math.round((+new Date(shift.ends_at)-+new Date(shift.starts_at))/60000);
      const worked = Math.max(0,gross-int(shift.break_minutes)); weekly += worked;
      const requiredBreak = gross > 540 ? int(profile.break_after_six_hours,20)+int(profile.additional_break_after_nine_hours,25) : gross > 360 ? int(profile.break_after_six_hours,20) : 0;
      const add = (code:string,severity:string,message:string) => warnings.push({code,severity,message,employee_id:employeeId,shift_id:shift.id,work_date:shift.work_date});
      if (worked > int(profile.max_daily_minutes,720)) add("DAILY_MAX","error",`A napi munkaidő ${worked} perc, a megengedett maximum ${int(profile.max_daily_minutes,720)} perc.`);
      if (worked > 0 && worked < int(profile.min_daily_minutes,240)) add("DAILY_MIN","warning",`A beosztás ${worked} perc; ellenőrizze a napi minimumot és a részmunkaidős kivételt.`);
      if (int(shift.break_minutes) < requiredBreak) add("BREAK","error",`Legalább ${requiredBreak} perc munkaközi szünet szükséges.`);
      const day = new Date(`${String(shift.work_date).slice(0,10)}T12:00:00`).getDay();
      if (day === 0 && !profile.allow_sunday) add("SUNDAY","error","Vasárnapi rendes munkaidő nincs engedélyezve a dolgozó profiljában.");
      if (holidays.has(String(shift.work_date).slice(0,10)) && !profile.allow_public_holiday) add("HOLIDAY","error","Munkaszüneti napi munkavégzés nincs engedélyezve a dolgozó profiljában.");
      const startHour = new Date(shift.starts_at).getHours(), endHour = new Date(shift.ends_at).getHours();
      if ((startHour >= 22 || startHour < 6 || endHour > 22 || endHour <= 6) && !profile.allow_night_work) add("NIGHT","error","Éjszakai munkavégzés nincs engedélyezve a dolgozó profiljában.");
      if (shift.status === "draft" && +new Date(shift.starts_at) < Date.now()+168*60*60000 && !shift.legal_override_reason) add("NOTICE_168H","error","A beosztás írásbeli közlésére előírt 168 órás határidő már nem biztosítható.");
      if (index > 0) {
        const rest = Math.round((+new Date(shift.starts_at)-+new Date(items[index-1].ends_at))/60000);
        if (rest < int(profile.min_daily_rest_minutes,660)) add("DAILY_REST","error",`Csak ${rest} perc napi pihenőidő marad; az előírt minimum ${int(profile.min_daily_rest_minutes,660)} perc.`);
      }
    });
    const workedDays=new Set(items.filter(x=>x.status!=="cancelled").map(x=>String(x.work_date).slice(0,10))).size;
    if(workedDays>6)warnings.push({code:"REST_DAY",severity:"error",message:"Hat egybefüggő munkanapot követően legalább egy heti pihenőnapot kell beosztani.",employee_id:employeeId});
    if (weekly > int(profile.max_weekly_minutes,2880)) warnings.push({code:"WEEKLY_MAX",severity:"error",message:`A heti beosztás ${weekly} perc, a maximum ${int(profile.max_weekly_minutes,2880)} perc.`,employee_id:employeeId});
  }
  return warnings;
}

type ColSet = Set<string>;
let employeesCols: ColSet | null = null;

async function loadTableCols(tableName: string): Promise<ColSet> {
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
    [tableName]
  );
  return new Set(r.rows.map((x: any) => String(x.column_name)));
}

async function loadEmployeesCols(): Promise<ColSet> {
  if (employeesCols) return employeesCols;
  employeesCols = await loadTableCols("employees");
  return employeesCols;
}

function pick(cols: ColSet, names: string[]): string | null {
  for (const n of names) if (cols.has(n)) return n;
  return null;
}

function buildEmployeesSelect(cols: ColSet, locationId: string | null = null) {
  const fullNameCol = pick(cols, ["full_name", "fullname", "name", "display_name"]);
  const shortNameCol = pick(cols, ["short_name", "shortname", "nick", "nickname", "initials"]);
  const firstNameCol = pick(cols, ["first_name", "firstname", "given_name"]);
  const lastNameCol = pick(cols, ["last_name", "lastname", "family_name"]);
  const photoCol = pick(cols, ["photo_url", "avatar_url", "image_url", "photo", "avatar"]);
  const roleCol = pick(cols, ["role", "position", "job_title"]);
  const locationCol = pick(cols, ["location_id", "salon_id", "branch_id"]);

  const fullNameExpr = fullNameCol
    ? `e.${fullNameCol}::text`
    : (firstNameCol || lastNameCol)
      ? `trim(concat_ws(' ', ${firstNameCol ? `e.${firstNameCol}::text` : "''"}, ${lastNameCol ? `e.${lastNameCol}::text` : "''"}))`
      : `'Munkatárs'`;
  const shortNameExpr = shortNameCol
    ? `e.${shortNameCol}::text`
    : (firstNameCol || lastNameCol)
      ? `trim(concat_ws(' ', ${firstNameCol ? `e.${firstNameCol}::text` : "''"}, ${lastNameCol ? `left(e.${lastNameCol}::text, 1) || '.'` : "''"}))`
      : `NULL::text`;
  const photoExpr = photoCol ? `e.${photoCol}::text` : `NULL::text`;
  const roleExpr = roleCol ? `e.${roleCol}::text` : `NULL::text`;
  const locExpr = locationCol ? `e.${locationCol}::text` : `NULL::text`;
  const where = locationCol && locationId ? `WHERE e.${locationCol}::text = $1` : "";

  return {
    sql: `SELECT e.id::text AS id, ${fullNameExpr} AS full_name, ${shortNameExpr} AS short_name,
                 ${photoExpr} AS photo_url, ${roleExpr} AS role, ${locExpr} AS location_id
          FROM employees e ${where}
          ORDER BY COALESCE(${shortNameExpr}, ${fullNameExpr}) ASC`,
    params: locationCol && locationId ? [locationId] : [] as any[],
  };
}

router.get("/schedule", asyncRoute(async (req, res) => {
  await ensureHrV2();
  const from=String(req.query.from||""),to=String(req.query.to||"");
  if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)) return res.status(400).json({error:"Érvényes from és to dátum szükséges."});
  const locationId=String(req.query.location_id||"")||null;
  const [employees,shifts,holidays,locations]=await Promise.all([
    pool.query(`SELECT e.id,e.full_name,e.photo_url,e.location_id,l.name location_name,e.position_id,p.name position_name,
      COALESCE(w.schedule_type,'general') schedule_type,COALESCE(w.weekly_minutes,2400) weekly_minutes,
      COALESCE(w.daily_minutes,480) daily_minutes,COALESCE(w.min_daily_minutes,240) min_daily_minutes,
      COALESCE(w.max_daily_minutes,720) max_daily_minutes,COALESCE(w.max_weekly_minutes,2880) max_weekly_minutes,
      COALESCE(w.min_daily_rest_minutes,660) min_daily_rest_minutes,COALESCE(w.min_weekly_rest_minutes,2880) min_weekly_rest_minutes,
      COALESCE(w.break_after_six_hours,20) break_after_six_hours,COALESCE(w.additional_break_after_nine_hours,25) additional_break_after_nine_hours,
      COALESCE(w.allow_split_shift,false) allow_split_shift,COALESCE(w.allow_sunday,false) allow_sunday,
      COALESCE(w.allow_public_holiday,false) allow_public_holiday,COALESCE(w.allow_night_work,false) allow_night_work,
      COALESCE(w.standby_position,false) standby_position,COALESCE(w.multi_shift_activity,false) multi_shift_activity,
      COALESCE(w.seasonal_activity,false) seasonal_activity,COALESCE(w.uninterrupted_activity,false) uninterrupted_activity,
      COALESCE(w.voluntary_overtime_agreement,false) voluntary_overtime_agreement,
      COALESCE(w.annual_overtime_limit,250) annual_overtime_limit,COALESCE(w.voluntary_overtime_limit,150) voluntary_overtime_limit,
      w.frame_start,w.frame_end,COALESCE(w.settlement_period_weeks,1) settlement_period_weeks,w.valid_from,w.valid_to,w.notes
      FROM employees e LEFT JOIN locations l ON l.id=e.location_id LEFT JOIN hr_positions p ON p.id=e.position_id
      LEFT JOIN employee_work_time_profiles w ON w.employee_id=e.id
      WHERE COALESCE(e.active,true) AND ($1::uuid IS NULL OR e.location_id=$1) ORDER BY e.full_name`,[locationId]),
    pool.query(`SELECT s.*,e.full_name,l.name location_name FROM work_shifts s JOIN employees e ON e.id=s.employee_id LEFT JOIN locations l ON l.id=s.location_id
      WHERE s.work_date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR s.location_id=$3 OR (s.location_id IS NULL AND e.location_id=$3)) ORDER BY s.starts_at`,[from,to,locationId]),
    pool.query("SELECT holiday_date,name FROM public_holidays WHERE is_active AND holiday_date BETWEEN $1 AND $2",[from,to]),
    pool.query("SELECT id,name FROM locations WHERE COALESCE(is_active,true) ORDER BY name")
  ]);
  const profiles=new Map(employees.rows.map((x:any)=>[String(x.id),x]));
  const holidaySet=new Set(holidays.rows.map((x:any)=>String(x.holiday_date).slice(0,10)));
  const warnings=legalWarnings(shifts.rows,profiles,holidaySet);
  const scheduledMinutes=shifts.rows.filter((x:any)=>x.status!=="cancelled").reduce((sum:number,x:any)=>sum+Math.max(0,Math.round((+new Date(x.ends_at)-+new Date(x.starts_at))/60000)-int(x.break_minutes)),0);
  res.json({from,to,employees:employees.rows,shifts:shifts.rows,holidays:holidays.rows,locations:locations.rows,warnings,summary:{employee_count:employees.rowCount||0,shift_count:shifts.rows.filter((x:any)=>x.status!=="cancelled").length,scheduled_minutes:scheduledMinutes,error_count:warnings.filter((x:any)=>x.severity==="error").length,warning_count:warnings.filter((x:any)=>x.severity!=="error").length}});
}));

router.put("/profiles/:employeeId", asyncRoute(async (req,res)=>{
  await ensureHrV2(); const b=req.body||{};
  const keys=["schedule_type","weekly_minutes","daily_minutes","frame_start","frame_end","settlement_period_weeks","min_daily_minutes","max_daily_minutes","max_weekly_minutes","min_daily_rest_minutes","min_weekly_rest_minutes","break_after_six_hours","additional_break_after_nine_hours","allow_split_shift","allow_sunday","allow_public_holiday","allow_night_work","standby_position","multi_shift_activity","seasonal_activity","uninterrupted_activity","voluntary_overtime_agreement","annual_overtime_limit","voluntary_overtime_limit","valid_from","valid_to","notes"];
  await pool.query("INSERT INTO employee_work_time_profiles(employee_id) VALUES($1) ON CONFLICT(employee_id) DO NOTHING",[req.params.employeeId]);
  const values:any[]=[req.params.employeeId];const sets:string[]=[];
  for(const k of keys)if(Object.prototype.hasOwnProperty.call(b,k)){values.push(b[k]===""?null:b[k]);sets.push(`${k}=$${values.length}`)}
  if(!sets.length)return res.status(400).json({error:"Nincs módosítandó munkaidő-beállítás."});
  const {rows}=await pool.query(`UPDATE employee_work_time_profiles SET ${sets.join(",")},updated_at=now() WHERE employee_id=$1 RETURNING *`,values);
  await pool.query("INSERT INTO work_schedule_change_log(employee_id,action,new_data,actor_user_id) VALUES($1,'profile_update',$2::jsonb,$3)",[req.params.employeeId,JSON.stringify(rows[0]),actor(req)]);
  res.json(rows[0]);
}));

router.post("/shifts", asyncRoute(async (req,res)=>{
  await ensureHrV2(); const b=req.body||{};
  if(!b.employee_id||!b.work_date||!b.starts_at||!b.ends_at)return res.status(400).json({error:"A dolgozó, dátum, kezdés és befejezés kötelező."});
  const {rows}=await pool.query(`INSERT INTO work_shifts(employee_id,location_id,work_date,starts_at,ends_at,break_minutes,shift_type,status,is_overtime,overtime_ordered,is_standby,is_on_call,is_training,legal_override_reason,note,created_by,updated_by)
    VALUES($1,$2,$3,$4,$5,COALESCE($6,0),COALESCE($7,'regular'),'draft',COALESCE($8,false),COALESCE($9,false),COALESCE($10,false),COALESCE($11,false),COALESCE($12,false),$13,$14,$15,$15) RETURNING *`,[b.employee_id,b.location_id||null,b.work_date,b.starts_at,b.ends_at,int(b.break_minutes),b.shift_type,b.is_overtime,b.overtime_ordered,b.is_standby,b.is_on_call,b.is_training,b.legal_override_reason||null,b.note||null,actor(req)]);
  await pool.query("INSERT INTO work_schedule_change_log(shift_id,employee_id,action,new_data,reason,actor_user_id) VALUES($1,$2,'create',$3::jsonb,$4,$5)",[rows[0].id,b.employee_id,JSON.stringify(rows[0]),b.legal_override_reason||null,actor(req)]);
  res.status(201).json(rows[0]);
}));

router.patch("/shifts/:id", asyncRoute(async (req,res)=>{
  await ensureHrV2(); const b=req.body||{}; const old=(await pool.query("SELECT * FROM work_shifts WHERE id=$1",[req.params.id])).rows[0];
  if(!old)return res.status(404).json({error:"A műszak nem található."});
  if(old.status==="published"&&+new Date(old.starts_at)<Date.now()+96*60*60000&&!String(b.legal_override_reason||"").trim())return res.status(422).json({error:"A 96 órán belül kezdődő, már közölt beosztás módosításához dokumentált indok szükséges."});
  const keys=["location_id","work_date","starts_at","ends_at","break_minutes","shift_type","is_overtime","overtime_ordered","is_standby","is_on_call","is_training","legal_override_reason","note","status"];
  const sets:string[]=[];const values:any[]=[req.params.id];for(const k of keys)if(Object.prototype.hasOwnProperty.call(b,k)){values.push(b[k]===""?null:b[k]);sets.push(`${k}=$${values.length}`)}
  if(!sets.length)return res.status(400).json({error:"Nincs módosítandó adat."});values.push(actor(req));
  const {rows}=await pool.query(`UPDATE work_shifts SET ${sets.join(",")},updated_by=$${values.length},updated_at=now() WHERE id=$1 RETURNING *`,values);
  await pool.query("INSERT INTO work_schedule_change_log(shift_id,employee_id,action,old_data,new_data,reason,actor_user_id) VALUES($1,$2,'update',$3::jsonb,$4::jsonb,$5,$6)",[req.params.id,old.employee_id,JSON.stringify(old),JSON.stringify(rows[0]),b.legal_override_reason||null,actor(req)]);
  res.json(rows[0]);
}));

router.delete("/shifts/:id", asyncRoute(async (req,res)=>{
  await ensureHrV2();const {rows}=await pool.query("UPDATE work_shifts SET status='cancelled',updated_by=$2,updated_at=now() WHERE id=$1 RETURNING *",[req.params.id,actor(req)]);
  if(!rows[0])return res.status(404).json({error:"A műszak nem található."});
  await pool.query("INSERT INTO work_schedule_change_log(shift_id,employee_id,action,old_data,actor_user_id) VALUES($1,$2,'cancel',$3::jsonb,$4)",[rows[0].id,rows[0].employee_id,JSON.stringify(rows[0]),actor(req)]);res.status(204).end();
}));

router.post("/publish", asyncRoute(async (req,res)=>{
  await ensureHrV2();const b=req.body||{};if(!b.from||!b.to)return res.status(400).json({error:"Az időszak kötelező."});
  const [sr,er,hr]=await Promise.all([pool.query("SELECT * FROM work_shifts WHERE work_date BETWEEN $1 AND $2 AND status<>'cancelled' AND ($3::uuid IS NULL OR location_id=$3)",[b.from,b.to,b.location_id||null]),pool.query("SELECT e.id,w.* FROM employees e LEFT JOIN employee_work_time_profiles w ON w.employee_id=e.id"),pool.query("SELECT holiday_date FROM public_holidays WHERE is_active AND holiday_date BETWEEN $1 AND $2",[b.from,b.to])]);
  const warnings=legalWarnings(sr.rows,new Map(er.rows.map((x:any)=>[String(x.id),x])),new Set(hr.rows.map((x:any)=>String(x.holiday_date).slice(0,10))));
  const errors=warnings.filter((x:any)=>x.severity==="error"&&!sr.rows.find((s:any)=>s.id===x.shift_id)?.legal_override_reason);
  if(errors.length)return res.status(422).json({error:"A beosztás munkajogi hibákat tartalmaz, ezért nem tehető közzé.",warnings});
  await pool.query("UPDATE work_shifts SET status='published',published_at=now(),published_by=$4,updated_at=now() WHERE work_date BETWEEN $1 AND $2 AND status='draft' AND ($3::uuid IS NULL OR location_id=$3)",[b.from,b.to,b.location_id||null,actor(req)]);
  await pool.query(`INSERT INTO work_schedule_publications(location_id,period_from,period_to,published_by,note) VALUES($1,$2,$3,$4,$5) ON CONFLICT(location_id,period_from,period_to) DO UPDATE SET published_at=now(),published_by=EXCLUDED.published_by,note=EXCLUDED.note`,[b.location_id||null,b.from,b.to,actor(req),b.note||null]);
  res.json({ok:true,warnings,published_at:new Date().toISOString()});
}));

/**
 * GET /api/timetable?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Schema-tolerant runtime query. Optional tables/legacy columns are only referenced when they exist.
 */
router.get("/", async (req: AuthRequest, res) => {
  const from=String(req.query.from||"");
  const to=String(req.query.to||"");
  const locationId=String(req.query.location_id||"").trim()||null;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: "Érvényes from és to query param kötelező (YYYY-MM-DD)" });
  }

  try {
    const [employeeCols, appointmentCols, clientCols, serviceLinkCols, productLinkCols, workOrderCols, locationCols] = await Promise.all([
      loadEmployeesCols(), loadTableCols("appointments"), loadTableCols("clients"), loadTableCols("appointment_services"),
      loadTableCols("appointment_products"), loadTableCols("work_orders"), loadTableCols("locations")
    ]);

    const employeeQuery=buildEmployeesSelect(employeeCols,locationId);
    const employeesRes=await pool.query(employeeQuery.sql,employeeQuery.params);

    if(!appointmentCols.size) return res.json({employees:employeesRes.rows,appointments:[]});
    const required=["id","employee_id","start_time","end_time"];
    const missing=required.filter(c=>!appointmentCols.has(c));
    if(missing.length) throw new Error(`appointments séma hiányos: ${missing.join(", ")}`);

    const aClient=appointmentCols.has("client_id");
    const aLocation=appointmentCols.has("location_id");
    const statusExpr=appointmentCols.has("status") ? `COALESCE(NULLIF(lower(a.status::text),''),'waiting')` : `'waiting'`;
    const titleExpr=appointmentCols.has("title") ? `a.title::text` : `NULL::text`;
    const notesExpr=appointmentCols.has("notes") ? `a.notes::text` : `NULL::text`;
    const clientIdExpr=aClient ? `a.client_id::text` : `NULL::text`;
    const locationIdExpr=aLocation ? `a.location_id::text` : `NULL::text`;

    let clientJoin="";
    let clientNameExpr=`''::text`;
    if(aClient && clientCols.has("id")) {
      clientJoin=`LEFT JOIN clients c ON c.id::text=a.client_id::text`;
      const nameParts=["full_name","name","display_name"].filter(c=>clientCols.has(c)).map(c=>`NULLIF(c.${c}::text,'')`);
      if(nameParts.length) clientNameExpr=`COALESCE(${nameParts.join(",")},'')`;
    }

    let locationJoin="";
    let locationNameExpr=`NULL::text`;
    if(aLocation && locationCols.has("id") && locationCols.has("name")) {
      locationJoin=`LEFT JOIN locations loc ON loc.id::text=a.location_id::text`;
      locationNameExpr=`loc.name::text`;
    }

    const hasWorkOrders=workOrderCols.has("id") && appointmentCols.has("work_order_id");
    const woStatus=(hasWorkOrders && workOrderCols.has("status")) ? `lower(COALESCE(w.status::text,''))` : `''`;
    const woClosedBits:string[]=[];
    if(hasWorkOrders && workOrderCols.has("locked_at")) woClosedBits.push(`w.locked_at IS NOT NULL`);
    if(hasWorkOrders && workOrderCols.has("archived_at")) woClosedBits.push(`w.archived_at IS NOT NULL`);
    const woClosed = hasWorkOrders ? `EXISTS(SELECT 1 FROM work_orders w WHERE w.id::text=a.work_order_id::text AND (${woStatus}='completed'${woClosedBits.length?` OR ${woClosedBits.join(" OR ")}`:""}))` : `false`;
    const woInProgress = hasWorkOrders && workOrderCols.has("status") ? `EXISTS(SELECT 1 FROM work_orders w WHERE w.id::text=a.work_order_id::text AND ${woStatus}='in_progress')` : `false`;
    const woArrived = hasWorkOrders && workOrderCols.has("status") ? `EXISTS(SELECT 1 FROM work_orders w WHERE w.id::text=a.work_order_id::text AND ${woStatus}='arrived')` : `false`;
    const operationalExpr=`CASE WHEN ${statusExpr} IN ('completed','paid') OR ${woClosed} THEN 'work_order_closed' WHEN ${statusExpr}='in_progress' OR ${woInProgress} THEN 'in_progress' WHEN ${statusExpr}='arrived' OR ${woArrived} THEN 'arrived' ELSE ${statusExpr} END`;

    let serviceNamesExpr=`ARRAY[]::text[]`;
    let serviceTotalExpr=`0::numeric`;
    if(serviceLinkCols.has("appointment_id")) {
      if(serviceLinkCols.has("service_id")) {
        const servicesCols=await loadTableCols("services");
        if(servicesCols.has("id") && servicesCols.has("name")) {
          const orderParts=["sort_order","created_at"].filter(c=>serviceLinkCols.has(c)).map(c=>`aps.${c}`);
          serviceNamesExpr=`COALESCE((SELECT array_agg(COALESCE(s.name::text,'')${orderParts.length?` ORDER BY ${orderParts.join(",")}`:""}) FROM appointment_services aps LEFT JOIN services s ON s.id::text=aps.service_id::text WHERE aps.appointment_id::text=a.id::text),ARRAY[]::text[])`;
        }
      }
      if(serviceLinkCols.has("price")) serviceTotalExpr=`COALESCE((SELECT SUM(COALESCE(aps.price,0)) FROM appointment_services aps WHERE aps.appointment_id::text=a.id::text),0)::numeric`;
    }

    let productTotalExpr=`0::numeric`;
    if(productLinkCols.has("appointment_id") && productLinkCols.has("price")) {
      const qty=productLinkCols.has("qty")?`COALESCE(ap.qty,1)`:productLinkCols.has("quantity")?`COALESCE(ap.quantity,1)`:`1`;
      productTotalExpr=`COALESCE((SELECT SUM(${qty}*COALESCE(ap.price,0)) FROM appointment_products ap WHERE ap.appointment_id::text=a.id::text),0)::numeric`;
    }

    const params:any[]=[from,to];
    let locationFilter="";
    if(locationId && aLocation){params.push(locationId);locationFilter=`AND a.location_id::text=$3`;}
    const apSql=`SELECT a.id::text,a.employee_id::text,${clientIdExpr} AS client_id,${clientNameExpr} AS client_name,
      ${locationIdExpr} AS location_id,${locationNameExpr} AS location_name,${titleExpr} AS title,a.start_time,a.end_time,
      ${appointmentCols.has("status")?`a.status::text`:`NULL::text`} AS status,${operationalExpr} AS operational_status,${notesExpr} AS notes,
      ${serviceNamesExpr} AS service_names,(${serviceTotalExpr}+${productTotalExpr})::numeric AS total
      FROM appointments a ${clientJoin} ${locationJoin}
      WHERE a.start_time>=($1::date)::timestamp AND a.start_time<(($2::date+INTERVAL '1 day')::timestamp) ${locationFilter}
      ORDER BY a.start_time ASC`;
    const apRes=await pool.query(apSql,params);

    return res.json({employees:employeesRes.rows,appointments:apRes.rows});
  } catch (err: any) {
    console.error("[/api/timetable] error:", err);
    return res.status(500).json({error:"Szerver hiba a timetable lekérésnél",detail:err?.message||String(err),code:err?.code||null});
  }
});

export default router;
