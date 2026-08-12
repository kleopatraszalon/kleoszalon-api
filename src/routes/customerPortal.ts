import { Router, Response, NextFunction } from "express";
import db from "../db";
import { AuthRequest, requireAuth } from "../middleware/auth";
import { ensureCustomerPortal } from "../customerPortal/ensureCustomerPortal";
import customerPortalSelfServiceRouter from "./customerPortalSelfService";
import {evaluateClient} from "../loyalty/loyaltyProgramService";

const router = Router();
router.use(requireAuth);
router.use(async (_req, _res, next) => {
  try { await ensureCustomerPortal(); next(); } catch (error) { next(error); }
});

type Customer = { id:string; full_name:string; email:string|null; phone:string|null; location_id:string|null; location_name:string|null };
const asyncRoute = (handler:(req:AuthRequest,res:Response)=>Promise<any>) => (req:AuthRequest,res:Response,next:NextFunction)=>handler(req,res).catch(next);

function roleList(raw:unknown):string[]{
  if(Array.isArray(raw)) return raw.map(String).map(x=>x.toLowerCase());
  const text=String(raw??"");
  try{const parsed=JSON.parse(text);if(Array.isArray(parsed))return parsed.map(String).map(x=>x.toLowerCase());if(parsed!=null)return[String(parsed).toLowerCase()];}catch{}
  return text.split(",").map(x=>x.replace(/[\[\]"]/g,"").trim().toLowerCase()).filter(Boolean);
}
function isCustomer(req:AuthRequest){return roleList(req.user?.role).some(r=>["customer","client","guest","ugyfel","ügyfél","vendeg","vendég"].includes(r));}
function requireCustomer(req:AuthRequest,res:Response,next:NextFunction){if(!isCustomer(req))return res.status(403).json({error:"Ez a felület csak ügyfél belépéssel használható."});next();}
router.use(requireCustomer);
router.use(customerPortalSelfServiceRouter);

async function resolveCustomer(req:AuthRequest):Promise<Customer|null>{
  const email=String(req.user?.email??"").trim();
  if(!email)return null;
  const {rows}=await db.query(
    `SELECT c.id::text id,COALESCE(NULLIF(c.full_name,''),NULLIF(c.name,''),'Vendég') full_name,
            c.email,c.phone,c.location_id::text location_id,l.name location_name
       FROM clients c
       LEFT JOIN locations l ON l.id=c.location_id
      WHERE lower(COALESCE(c.email,''))=lower($1)
      ORDER BY c.updated_at DESC NULLS LAST,c.created_at DESC NULLS LAST
      LIMIT 1`,[email]
  );
  return rows[0]??null;
}

router.get("/dashboard",asyncRoute(async(req,res)=>{
  const customer=await resolveCustomer(req);
  if(!customer)return res.status(404).json({error:"A belépett fiókhoz nem található ügyféladatlap."});

  const accountResult=await db.query(
    `SELECT * FROM loyalty_accounts
      WHERE customer_id=$1 OR lower(customer_id)=lower($2)
      ORDER BY updated_at DESC LIMIT 1`,[customer.id,customer.email||""]
  );
  const account=accountResult.rows[0]??null;
  const accountId=account?.id??null;
  await evaluateClient(db,customer.id,"customer_dashboard");
  const loyaltyProgram=(await db.query(`SELECT pm.*,t.name tier_name,t.color,t.discount_percent,(SELECT MIN(x.paid_threshold) FROM loyalty_program_tiers x WHERE x.is_active AND x.sort_order>COALESCE(t.sort_order,0)) next_paid_threshold FROM loyalty_program_members pm LEFT JOIN loyalty_program_tiers t ON t.code=pm.tier_code WHERE pm.client_id=$1::uuid`,[customer.id])).rows[0]||null;

  const [passes,coupons,promoServices,appointments,transactions]=await Promise.all([
    accountId?db.query(
      `SELECT p.id::text,p.status,p.valid_from,p.valid_until,t.name pass_type_name,t.sale_price,
              COALESCE(SUM(b.original_quantity),0)::numeric original_units,
              COALESCE(SUM(b.remaining_quantity),0)::numeric remaining_units,
              COALESCE(jsonb_agg(jsonb_build_object(
                'service_id',b.service_id,'service_name',COALESCE(s.name,'Szolgáltatás'),
                'original_quantity',b.original_quantity,'remaining_quantity',b.remaining_quantity
              )) FILTER(WHERE b.id IS NOT NULL),'[]'::jsonb) services
         FROM loyalty_passes p
         JOIN loyalty_pass_types t ON t.id=p.pass_type_id
         LEFT JOIN loyalty_pass_balances b ON b.pass_id=p.id
         LEFT JOIN services s ON s.id::text=b.service_id
        WHERE p.account_id=$1::uuid AND p.status='active' AND (p.valid_until IS NULL OR p.valid_until>=CURRENT_DATE)
        GROUP BY p.id,t.id
        ORDER BY p.valid_until NULLS LAST`,[accountId]
    ):Promise.resolve({rows:[]} as any),
    db.query(
      `SELECT cc.id::text campaign_id,cc.name,cc.discount_type,cc.discount_value,cc.valid_from,cc.valid_until,
              cc.min_order_value,cc.max_discount_value,cc.applies_to_all,c.code
         FROM loyalty_coupon_campaigns cc
         LEFT JOIN loyalty_coupons c ON c.campaign_id=cc.id AND c.active=true
           AND (c.customer_id=$1 OR lower(COALESCE(c.customer_id,''))=lower($2))
        WHERE cc.active=true
          AND (cc.valid_from IS NULL OR cc.valid_from<=now())
          AND (cc.valid_until IS NULL OR cc.valid_until>=now())
          AND (cc.applies_to_all=true OR c.id IS NOT NULL)
        ORDER BY c.id IS NOT NULL DESC,cc.valid_until NULLS LAST,cc.created_at DESC
        LIMIT 20`,[customer.id,customer.email||""]
    ),
    db.query(
      `SELECT s.id::text service_id,s.name,
              COALESCE(s.list_price,s.base_price,0)::numeric regular_price,
              s.promo_price::numeric promo_price,
              st.name category_name
         FROM services s LEFT JOIN service_types st ON st.id=s.service_type_id
        WHERE COALESCE(s.is_active,true)=true AND s.promo_price IS NOT NULL
          AND s.promo_price < COALESCE(s.list_price,s.base_price,s.promo_price+1)
        ORDER BY (COALESCE(s.list_price,s.base_price,0)-s.promo_price) DESC,s.name
        LIMIT 12`
    ),
    db.query(
      `SELECT a.id::text,a.title,a.start_time,a.end_time,a.status,e.full_name employee_name,l.name location_name
         FROM appointments a
         LEFT JOIN employees e ON e.id=a.employee_id
         LEFT JOIN locations l ON l.id=a.location_id
        WHERE a.client_id::text=$1 AND a.start_time>=now() AND a.status NOT IN('cancelled','canceled','no_show')
        ORDER BY a.start_time LIMIT 8`,[customer.id]
    ),
    accountId?db.query(
      `SELECT transaction_type,amount,points,note,created_at
         FROM loyalty_transactions WHERE account_id=$1::uuid ORDER BY created_at DESC LIMIT 8`,[accountId]
    ):Promise.resolve({rows:[]} as any),
  ]);

  res.json({
    customer,
    account:account?{
      id:String(account.id),balance:Number(account.balance||0),points:Number(account.points||0),
      card_identifier:account.card_identifier??null,status:account.status
    }:{id:null,balance:0,points:0,card_identifier:null,status:"inactive"},
    loyalty_program:loyaltyProgram?{...loyaltyProgram,amount_to_next_tier:loyaltyProgram.next_paid_threshold==null?0:Math.max(0,Number(loyaltyProgram.next_paid_threshold)-Number(loyaltyProgram.paid_total||0))}:null,
    passes:passes.rows,
    discounts:coupons.rows,
    promotions:[
      ...coupons.rows.map((x:any)=>({kind:"discount",title:x.name,discount_type:x.discount_type,discount_value:Number(x.discount_value||0),valid_until:x.valid_until,code:x.code||null})),
      ...promoServices.rows.map((x:any)=>({kind:"service",title:x.name,category_name:x.category_name,regular_price:Number(x.regular_price||0),promo_price:Number(x.promo_price||0),service_id:x.service_id}))
    ],
    upcoming_appointments:appointments.rows,
    recent_transactions:transactions.rows,
  });
}));

async function bookingSettings(locationId:string){
  const {rows}=await db.query(`SELECT * FROM online_booking_settings WHERE location_id=$1::uuid`,[locationId]);
  return rows[0]||{enabled:true,slot_interval_minutes:15,opening_minute:480,closing_minute:1200,booking_horizon_days:60,minimum_notice_minutes:60};
}

router.get("/booking/options",asyncRoute(async(req,res)=>{
  const locationId=String(req.query.location_id||"").trim();
  const date=String(req.query.date||"").trim();
  const serviceFilter=String(req.query.service_id||"").trim();
  const employeeFilter=String(req.query.employee_id||"").trim();
  if(!locationId||!/^\d{4}-\d{2}-\d{2}$/.test(date))return res.status(400).json({error:"location_id és érvényes date kötelező."});

  const cfg=await bookingSettings(locationId);
  if(cfg.enabled===false)return res.status(403).json({error:"Az online foglalás ezen a szalonban ki van kapcsolva."});
  const bounds=await db.query(
    `SELECT (($1::date + make_interval(mins=>$2::int)) AT TIME ZONE 'Europe/Budapest') AS starts_at,
            (($1::date + make_interval(mins=>$3::int)) AT TIME ZONE 'Europe/Budapest') AS ends_at`,
    [date,Number(cfg.opening_minute||480),Number(cfg.closing_minute||1200)]
  );
  const openAt=new Date(bounds.rows[0].starts_at),closeAt=new Date(bounds.rows[0].ends_at);
  const horizon=new Date();horizon.setDate(horizon.getDate()+Number(cfg.booking_horizon_days||60));
  if(openAt>horizon)return res.json({services:[],employees:[],slots:[],settings:cfg});

  const [serviceResult,employeeResult,overrideResult]=await Promise.all([
    db.query(
      `SELECT s.id::text id,s.name,COALESCE(s.duration_minutes,30)::int duration_minutes,
              COALESCE(s.promo_price,s.list_price,s.base_price,0)::numeric price,
              COALESCE(st.name,'Egyéb szolgáltatások') category_name
         FROM services s LEFT JOIN service_types st ON st.id=s.service_type_id
        WHERE COALESCE(s.is_active,true)=true AND COALESCE(s.online_bookable,true)=true
          AND (NOT EXISTS(SELECT 1 FROM service_locations sl0 WHERE sl0.service_id=s.id)
               OR EXISTS(SELECT 1 FROM service_locations sl WHERE sl.service_id=s.id AND sl.location_id=$1::uuid))
        ORDER BY COALESCE(st.display_order,999999),st.name,s.name`,[locationId]
    ),
    db.query(
      `SELECT e.id::text id,COALESCE(NULLIF(e.full_name,''),NULLIF(concat_ws(' ',e.last_name,e.first_name),''),'Munkatárs') full_name,e.photo_url,e.color
         FROM employees e WHERE COALESCE(e.active,true)=true AND (e.location_id=$1::uuid OR e.location_id IS NULL)
        ORDER BY COALESCE(NULLIF(e.full_name,''),e.last_name,e.first_name,'')`,[locationId]
    ),
    db.query(
      `SELECT employee_id::text,service_id::text FROM employee_service_overrides
        WHERE employee_id IN(SELECT id FROM employees WHERE COALESCE(active,true)=true AND (location_id=$1::uuid OR location_id IS NULL))`,[locationId]
    )
  ]);
  const services=serviceResult.rows,employees=employeeResult.rows;
  if(!services.length||!employees.length)return res.json({services:[],employees:[],slots:[],settings:cfg});

  const busy=await db.query(
    `SELECT employee_id::text,start_time,end_time FROM appointments
      WHERE location_id=$1::uuid AND employee_id=ANY($2::uuid[]) AND status NOT IN('cancelled','canceled','no_show')
        AND start_time<$4::timestamptz AND end_time>$3::timestamptz
     UNION ALL
     SELECT employee_id::text,start_time,end_time FROM appointment_technical_breaks
      WHERE location_id=$1::uuid AND employee_id=ANY($2::uuid[])
        AND start_time<$4::timestamptz AND end_time>$3::timestamptz`,
    [locationId,employees.map((e:any)=>e.id),openAt.toISOString(),closeAt.toISOString()]
  );

  const overrideMap=new Map<string,Set<string>>();
  for(const row of overrideResult.rows){const key=String(row.employee_id);if(!overrideMap.has(key))overrideMap.set(key,new Set());overrideMap.get(key)!.add(String(row.service_id));}
  const busyMap=new Map<string,any[]>();
  for(const row of busy.rows){const key=String(row.employee_id);if(!busyMap.has(key))busyMap.set(key,[]);busyMap.get(key)!.push(row);}
  const availableServices=new Set<string>(),availableEmployees=new Set<string>();
  const slots:any[]=[];
  const step=Math.max(5,Number(cfg.slot_interval_minutes||15));
  const noticeAt=new Date(Date.now()+Number(cfg.minimum_notice_minutes||0)*60000);

  for(const service of services){
    if(serviceFilter&&String(service.id)!==serviceFilter)continue;
    const duration=Math.max(5,Number(service.duration_minutes||30));
    for(const employee of employees){
      if(employeeFilter&&String(employee.id)!==employeeFilter)continue;
      const allowed=overrideMap.get(String(employee.id));
      if(allowed&&allowed.size&&!allowed.has(String(service.id)))continue;
      const blocks=busyMap.get(String(employee.id))||[];
      const pairSlots:any[]=[];
      for(let cursor=new Date(openAt);cursor<closeAt;cursor=new Date(cursor.getTime()+step*60000)){
        const end=new Date(cursor.getTime()+duration*60000);
        if(end>closeAt||cursor<noticeAt)continue;
        if(blocks.some((b:any)=>new Date(b.start_time)<end&&new Date(b.end_time)>cursor))continue;
        pairSlots.push({service_id:String(service.id),service_name:service.name,employee_id:String(employee.id),employee_name:employee.full_name,start:cursor.toISOString(),end:end.toISOString()});
      }
      if(pairSlots.length){
        availableServices.add(String(service.id));availableEmployees.add(String(employee.id));
        if(serviceFilter||employeeFilter)slots.push(...pairSlots.slice(0,60));
      }
    }
  }

  res.json({
    services:services.filter((s:any)=>availableServices.has(String(s.id))),
    employees:employees.filter((e:any)=>availableEmployees.has(String(e.id))),
    slots:slots.sort((a,b)=>a.start.localeCompare(b.start)||a.employee_name.localeCompare(b.employee_name,"hu")).slice(0,240),
    settings:cfg,
  });
}));

export default router;
