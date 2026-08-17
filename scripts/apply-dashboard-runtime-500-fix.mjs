import fs from 'node:fs';

function read(path){return fs.readFileSync(path,'utf8')}
function write(path,content){fs.writeFileSync(path,content,'utf8')}
function replaceOnce(source,before,after,label){
  if(!source.includes(before))throw new Error(`Missing patch target: ${label}`);
  const first=source.indexOf(before),second=source.indexOf(before,first+before.length);
  if(second!==-1)throw new Error(`Patch target is not unique: ${label}`);
  return source.replace(before,after);
}

// employees: make dashboard employee lookup tolerant of legacy text/uuid ids and honor location_id.
{
  const path='src/routes/employees.ts';
  let s=read(path);
  s=replaceOnce(s,
    'FROM employees e LEFT JOIN locations l ON l.id=e.location_id LEFT JOIN hr_positions p ON p.id::text=e.position_id::text`;
    ,
    'FROM employees e LEFT JOIN locations l ON l.id::text=e.location_id::text LEFT JOIN hr_positions p ON p.id::text=e.position_id::text`;',
    'employees location join');
  s=replaceOnce(s,
    'async function listEmployeesLegacy(includeInactive:boolean){return pool.query(`${employeeSelect} ${includeInactive?"":"WHERE COALESCE(e.active,true)=true"} ORDER BY e.active DESC,e.full_name NULLS LAST,e.last_name,e.first_name`)}',
    'async function listEmployeesLegacy(includeInactive:boolean,locationId:string|null=null){const filters:string[]=[];const values:any[]=[];if(!includeInactive)filters.push("COALESCE(e.active,true)=true");if(locationId){values.push(locationId);filters.push(`e.location_id::text=$${values.length}::text`)}const where=filters.length?`WHERE ${filters.join(" AND ")}`:"";return pool.query(`${employeeSelect} ${where} ORDER BY e.active DESC,e.full_name NULLS LAST,e.last_name,e.first_name`,values)}',
    'legacy employee location filter');
  s=replaceOnce(s,
    "if(positionId)filters.push(`e.position_id=${add(positionId,'uuid')}`);if(locationId)filters.push(`e.location_id=${add(locationId,'uuid')}`);if(employmentType)filters.push(`e.employment_type=${add(employmentType,'text')}`);",
    "if(positionId)filters.push(`e.position_id::text=${add(positionId,'text')}`);if(locationId)filters.push(`e.location_id::text=${add(locationId,'text')}`);if(employmentType)filters.push(`e.employment_type=${add(employmentType,'text')}`);",
    'employee filter legacy ids');
  s=replaceOnce(s,
    'if(!paginated){const{rows}=await listEmployeesLegacy(includeInactive);return res.json(rows)}',
    'if(!paginated){const locationId=String(req.query.location_id||"").trim()||null;const{rows}=await listEmployeesLegacy(includeInactive,locationId);return res.json(rows)}',
    'employee non-paginated location');
  s=replaceOnce(s,
    'SELECT COUNT(*)::int total FROM employees e LEFT JOIN locations l ON l.id=e.location_id LEFT JOIN hr_positions p ON p.id::text=e.position_id::text ${plan.where}',
    'SELECT COUNT(*)::int total FROM employees e LEFT JOIN locations l ON l.id::text=e.location_id::text LEFT JOIN hr_positions p ON p.id::text=e.position_id::text ${plan.where}',
    'employee paginated location join');
  s=replaceOnce(s,
    'if(!paginated){const{rows}=await listEmployeesLegacy(includeInactive);return res.json(rows)}throw error',
    'if(!paginated){const locationId=String(req.query.location_id||"").trim()||null;const{rows}=await listEmployeesLegacy(includeInactive,locationId);return res.json(rows)}throw error',
    'employee fallback location');
  write(path,s);
}

// timetable: remove unsafe UUID casts, make joins legacy-safe, and never reference optional tables unless they exist.
{
  const path='src/routes/timetable.ts';
  let s=read(path);
  s=replaceOnce(s,'function buildEmployeesSelect(cols: ColSet) {','function buildEmployeesSelect(cols: ColSet, locationId: string | null = null) {','timetable employee select signature');
  s=replaceOnce(s,
    'const locExpr = locationCol ? `e.${locationCol}::uuid` : `NULL::uuid`;',
    'const locExpr = locationCol ? `e.${locationCol}::text` : `NULL::text`;\n  const locationWhere = locationId && locationCol ? `WHERE e.${locationCol}::text = $1::text` : ``;',
    'timetable location expression');
  s=replaceOnce(s,
    '    FROM employees e\n    ORDER BY COALESCE(${shortNameExpr}, ${fullNameExpr}) ASC',
    '    FROM employees e\n    ${locationWhere}\n    ORDER BY COALESCE(${shortNameExpr}, ${fullNameExpr}) ASC',
    'timetable employee select filter');
  s=s.replaceAll('LEFT JOIN locations l ON l.id=e.location_id LEFT JOIN hr_positions p ON p.id=e.position_id','LEFT JOIN locations l ON l.id::text=e.location_id::text LEFT JOIN hr_positions p ON p.id::text=e.position_id::text');
  s=s.replaceAll('LEFT JOIN locations l ON l.id=s.location_id','LEFT JOIN locations l ON l.id::text=s.location_id::text');
  s=s.replaceAll('($1::uuid IS NULL OR e.location_id=$1)','($1::text IS NULL OR e.location_id::text=$1::text)');
  s=s.replaceAll('($3::uuid IS NULL OR s.location_id=$3 OR (s.location_id IS NULL AND e.location_id=$3))','($3::text IS NULL OR s.location_id::text=$3::text OR (s.location_id IS NULL AND e.location_id::text=$3::text))');
  s=s.replaceAll('($3::uuid IS NULL OR location_id=$3)','($3::text IS NULL OR location_id::text=$3::text)');

  s=replaceOnce(s,
    '    const cols = await loadEmployeesCols();\n    const employeesSql = buildEmployeesSelect(cols);\n    const employeesRes = await pool.query(employeesSql);',
    '    const locationId=String((req.query as any).location_id||"").trim()||null;\n    const cols = await loadEmployeesCols();\n    const employeesSql = buildEmployeesSelect(cols,locationId);\n    const employeesRes = await pool.query(employeesSql,locationId?[locationId]:[]);',
    'timetable root location scope');

  const blockStart='    const apRes = await pool.query(\n      `\n      WITH has_aps AS (';
  const start=s.indexOf(blockStart);
  if(start===-1)throw new Error('Missing patch target: timetable appointment query start');
  const endMarker='      [from, to]\n    );';
  const endStart=s.indexOf(endMarker,start);
  if(endStart===-1)throw new Error('Missing patch target: timetable appointment query end');
  const end=endStart+endMarker.length;
  const replacement=`    const relationState=await pool.query(\`SELECT to_regclass('public.appointment_services') IS NOT NULL has_services,to_regclass('public.appointment_products') IS NOT NULL has_products\`);\n    const hasServices=Boolean(relationState.rows[0]?.has_services),hasProducts=Boolean(relationState.rows[0]?.has_products);\n    const serviceNamesSql=hasServices\n      ? \`COALESCE((SELECT array_agg(COALESCE(s.name,'') ORDER BY aps.sort_order,aps.created_at) FROM appointment_services aps LEFT JOIN services s ON s.id::text=aps.service_id::text WHERE aps.appointment_id::text=a.id::text),ARRAY[]::text[])\`\n      : \`ARRAY[]::text[]\`;\n    const serviceTotalSql=hasServices\n      ? \`COALESCE((SELECT SUM(COALESCE(aps.price,0)) FROM appointment_services aps WHERE aps.appointment_id::text=a.id::text),0)\`\n      : \`0\`;\n    const productTotalSql=hasProducts\n      ? \`COALESCE((SELECT SUM(COALESCE(ap.qty,1)*COALESCE(ap.price,0)) FROM appointment_products ap WHERE ap.appointment_id::text=a.id::text),0)\`\n      : \`0\`;\n\n    const apRes = await pool.query(\n      \`\n      SELECT\n        a.id::text,\n        a.employee_id::text,\n        a.client_id::text AS client_id,\n        COALESCE(NULLIF(to_jsonb(c)->>'full_name',''),NULLIF(to_jsonb(c)->>'name',''),'') AS client_name,\n        a.location_id::text,\n        NULL::text AS location_name,\n        a.title,\n        a.start_time,\n        a.end_time,\n        a.status,\n        CASE\n          WHEN lower(COALESCE(a.status,'')) IN ('completed','paid')\n            OR EXISTS(\n              SELECT 1 FROM work_orders w\n              WHERE w.id::text = NULLIF(to_jsonb(a)->>'work_order_id','')\n                AND (\n                  lower(COALESCE(to_jsonb(w)->>'status',''))='completed'\n                  OR NULLIF(to_jsonb(w)->>'locked_at','') IS NOT NULL\n                  OR NULLIF(to_jsonb(w)->>'archived_at','') IS NOT NULL\n                )\n            ) THEN 'work_order_closed'\n          WHEN lower(COALESCE(a.status,''))='in_progress'\n            OR EXISTS(SELECT 1 FROM work_orders w WHERE w.id::text=NULLIF(to_jsonb(a)->>'work_order_id','') AND lower(COALESCE(to_jsonb(w)->>'status',''))='in_progress') THEN 'in_progress'\n          WHEN lower(COALESCE(a.status,''))='arrived'\n            OR EXISTS(SELECT 1 FROM work_orders w WHERE w.id::text=NULLIF(to_jsonb(a)->>'work_order_id','') AND lower(COALESCE(to_jsonb(w)->>'status',''))='arrived') THEN 'arrived'\n          ELSE COALESCE(NULLIF(lower(a.status),''),'waiting')\n        END AS operational_status,\n        a.notes,\n        \${serviceNamesSql} AS service_names,\n        (\${serviceTotalSql}+\${productTotalSql})::numeric AS total\n      FROM appointments a\n      LEFT JOIN clients c ON c.id::text=a.client_id::text\n      WHERE a.start_time >= ($1::date)::timestamp\n        AND a.start_time < (($2::date + INTERVAL '1 day')::timestamp)\n        AND ($3::text IS NULL OR a.location_id::text=$3::text)\n      ORDER BY a.start_time ASC\n      \`,\n      [from,to,locationId]\n    );`;
  s=s.slice(0,start)+replacement+s.slice(end);
  write(path,s);
}

// Keep the current frontend contract working while also exposing the structured config.
{
  const path='src/routes/virCustomizer.ts';
  let s=read(path);
  s=replaceOnce(s,
    "router.get('/',requireAuth,async(_req,res,next)=>{try{await ensure();const row=(await db.query(`SELECT config,updated_by,updated_at FROM vir_customization WHERE id=1`)).rows[0];res.json({config:merge(DEFAULTS,row?.config||{}),updated_by:row?.updated_by,updated_at:row?.updated_at})}catch(e){next(e)}});",
    "router.get('/',requireAuth,async(_req,res,next)=>{try{await ensure();const row=(await db.query(`SELECT config,updated_by,updated_at FROM vir_customization WHERE id=1`)).rows[0];const config=merge(DEFAULTS,row?.config||{});res.json({config,content:JSON.stringify(config),updated_by:row?.updated_by,updated_at:row?.updated_at})}catch(e){next(e)}});",
    'vir customizer compatibility response');
  write(path,s);
}

console.log('Dashboard runtime 500/404 compatibility fixes applied.');
