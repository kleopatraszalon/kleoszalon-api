import { Router, Request, Response } from "express";
import pool from "../db";
import productsImportRouter from "./productsImport";

const router = Router();
router.use(productsImportRouter);

type ProductRow = {
  id:string; name:string; internal_code:string|null; barcode:string|null; brand:string|null; line_name:string|null;
  product_group_id:string|null; product_category_id:string|null; base_unit_id:string|null; package_size:number|null; vat_rate:number|null;
  purchase_price_net:number|null; retail_price_gross:number|null; is_active:boolean|null; is_service_material:boolean|null; is_retail:boolean|null;
  is_cleaning:boolean|null; is_hospitality:boolean|null; is_merchandise:boolean|null; size_label:string|null; color_text:string|null; target_gender:string|null;
  product_type_code?:string|null; product_type_name?:string|null; product_group_name?:string|null; product_category_name?:string|null;
  critical_quantity?:number|null; ordered_quantity?:number|null;
};

function mapRowToProduct(row:any):ProductRow{return {
  id:row.id,name:row.name,internal_code:row.internal_code,barcode:row.barcode,brand:row.brand,line_name:row.line_name,
  product_group_id:row.product_group_id,product_category_id:row.product_category_id,base_unit_id:row.base_unit_id,package_size:row.package_size,vat_rate:row.vat_rate,
  purchase_price_net:row.purchase_price_net==null?null:Number(row.purchase_price_net),retail_price_gross:row.retail_price_gross==null?null:Number(row.retail_price_gross),is_active:row.is_active,
  is_service_material:row.is_service_material,is_retail:row.is_retail,is_cleaning:row.is_cleaning,is_hospitality:row.is_hospitality,is_merchandise:row.is_merchandise,
  size_label:row.size_label,color_text:row.color_text,target_gender:row.target_gender,
  product_type_code:row.product_type_code,product_type_name:row.product_type_name,product_group_name:row.product_group_name,product_category_name:row.product_category_name,
  critical_quantity:row.critical_quantity==null?null:Number(row.critical_quantity),ordered_quantity:row.ordered_quantity==null?null:Number(row.ordered_quantity)
};}

async function taxonomyNameColumns(){
  const q=await pool.query(`SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('product_groups','product_categories') AND column_name IN ('name','name_hu')`);
  const set=new Set(q.rows.map((r:any)=>`${r.table_name}.${r.column_name}`));
  return {group:set.has('product_groups.name')?'name':'name_hu',cat:set.has('product_categories.name')?'name':'name_hu'};
}

router.get("/",async(req:Request,res:Response)=>{try{
  const includeInactive=String(req.query.include_inactive||"")==="1"; const n=await taxonomyNameColumns();
  const sql=`SELECT p.*,pg.product_type_code,pg.product_type_name,pg.${n.group} AS product_group_name,pc.${n.cat} AS product_category_name FROM products p LEFT JOIN product_groups pg ON pg.id=p.product_group_id LEFT JOIN product_categories pc ON pc.id=p.product_category_id WHERE ($1::boolean) OR p.is_active=true ORDER BY pg.product_type_name NULLS LAST,pg.${n.group} NULLS LAST,pc.${n.cat} NULLS LAST,p.name`;
  const {rows}=await pool.query(sql,[includeInactive]); res.json(rows.map(mapRowToProduct));
}catch(err){console.error('GET /products hiba:',err);res.status(500).json({error:'Nem sikerült lekérdezni a termékeket.'});}});

router.get("/:id",async(req:Request,res:Response)=>{try{const n=await taxonomyNameColumns();const {rows}=await pool.query(`SELECT p.*,pg.product_type_code,pg.product_type_name,pg.${n.group} AS product_group_name,pc.${n.cat} AS product_category_name FROM products p LEFT JOIN product_groups pg ON pg.id=p.product_group_id LEFT JOIN product_categories pc ON pc.id=p.product_category_id WHERE p.id=$1::uuid LIMIT 1`,[req.params.id]);if(!rows.length)return res.status(404).json({error:'Termék nem található.'});res.json(mapRowToProduct(rows[0]));}catch(err){console.error(err);res.status(500).json({error:'Nem sikerült lekérdezni a terméket.'});}});

router.post("/",async(req:Request,res:Response)=>{try{const b=req.body||{};if(!String(b.name||'').trim())return res.status(400).json({error:'A termék neve kötelező.'});const {rows}=await pool.query(`INSERT INTO products(name,internal_code,barcode,brand,line_name,product_group_id,product_category_id,purchase_price_net,retail_price_gross,vat_rate,size_label,color_text,target_gender,is_active,is_service_material,is_retail,is_cleaning,is_hospitality,is_merchandise) VALUES($1::text,$2::text,$3::text,$4::text,$5::text,$6::uuid,$7::uuid,$8::numeric,$9::numeric,$10::numeric,$11::text,$12::text,$13::text,COALESCE($14::boolean,true),COALESCE($15::boolean,false),COALESCE($16::boolean,true),COALESCE($17::boolean,false),COALESCE($18::boolean,false),COALESCE($19::boolean,false)) RETURNING *`,[String(b.name).trim(),b.internal_code??null,b.barcode??null,b.brand??null,b.line_name??null,b.product_group_id||null,b.product_category_id||null,b.purchase_price_net??null,b.retail_price_gross??null,b.vat_rate??null,b.size_label??null,b.color_text??null,b.target_gender??null,b.is_active,b.is_service_material,b.is_retail,b.is_cleaning,b.is_hospitality,b.is_merchandise]);res.status(201).json(mapRowToProduct(rows[0]));}catch(err){console.error(err);res.status(500).json({error:'Nem sikerült létrehozni a terméket.'});}});

router.patch("/:id",async(req:Request,res:Response)=>{try{const b=req.body||{};const fields:string[]=[];const values:any[]=[];let i=1;const add=(c:string,v:any,cast:string='')=>{fields.push(`${c}=$${i}${cast}`);values.push(v);i++;};
  if(b.name!==undefined)add('name',b.name,'::text'); if(b.internal_code!==undefined)add('internal_code',b.internal_code,'::text'); if(b.barcode!==undefined)add('barcode',b.barcode,'::text'); if(b.brand!==undefined)add('brand',b.brand,'::text'); if(b.line_name!==undefined)add('line_name',b.line_name,'::text'); if(b.product_group_id!==undefined)add('product_group_id',b.product_group_id||null,'::uuid'); if(b.product_category_id!==undefined)add('product_category_id',b.product_category_id||null,'::uuid'); if(b.purchase_price_net!==undefined)add('purchase_price_net',b.purchase_price_net,'::numeric'); if(b.retail_price_gross!==undefined)add('retail_price_gross',b.retail_price_gross,'::numeric'); if(b.vat_rate!==undefined)add('vat_rate',b.vat_rate,'::numeric'); if(b.size_label!==undefined)add('size_label',b.size_label,'::text'); if(b.color_text!==undefined)add('color_text',b.color_text,'::text'); if(b.target_gender!==undefined)add('target_gender',b.target_gender,'::text'); if(b.is_active!==undefined)add('is_active',b.is_active,'::boolean'); if(b.is_service_material!==undefined)add('is_service_material',b.is_service_material,'::boolean'); if(b.is_retail!==undefined)add('is_retail',b.is_retail,'::boolean'); if(b.is_cleaning!==undefined)add('is_cleaning',b.is_cleaning,'::boolean'); if(b.is_hospitality!==undefined)add('is_hospitality',b.is_hospitality,'::boolean'); if(b.is_merchandise!==undefined)add('is_merchandise',b.is_merchandise,'::boolean');
  if(!fields.length)return res.json({message:'Nincs módosítandó mező.'});values.push(req.params.id);const {rows}=await pool.query(`UPDATE products SET ${fields.join(',')} WHERE id=$${i}::uuid RETURNING *`,values);if(!rows.length)return res.status(404).json({error:'Termék nem található.'});res.json(mapRowToProduct(rows[0]));
}catch(err){console.error(err);res.status(500).json({error:'Nem sikerült módosítani a terméket.'});}});

router.post("/bulk-import",async(req:Request,res:Response)=>{try{const items=(req.body&&(req.body as any).items)||[];if(!Array.isArray(items)||!items.length)return res.status(400).json({error:'Nincs importálható adat (items).'});const {rows:groupRows}=await pool.query('SELECT id,COALESCE(name,name_hu) name FROM product_groups');const {rows:catRows}=await pool.query('SELECT id,COALESCE(name,name_hu) name,product_group_id FROM product_categories');let created=0;const errors:string[]=[];for(let i=0;i<items.length;i++){const item=items[i];const name=String(item.name||'').trim();if(!name){errors.push(`Sor ${i+1}: név hiányzik.`);continue;}const g=groupRows.find((x:any)=>String(x.name).toLowerCase()===String(item.product_group_name||'').toLowerCase());const c=catRows.find((x:any)=>String(x.name).toLowerCase()===String(item.product_category_name||'').toLowerCase());try{await pool.query(`INSERT INTO products(name,internal_code,barcode,brand,product_group_id,product_category_id,retail_price_gross,is_active) VALUES($1::text,$2::text,$3::text,$4::text,$5::uuid,$6::uuid,$7::numeric,true)`,[name,item.internal_code||null,item.barcode||null,item.brand||null,g?.id||null,c?.id||null,item.retail_price_gross??null]);created++;}catch{errors.push(`Sor ${i+1}: ${name} mentése nem sikerült.`)}}res.json({message:`Import kész. Létrehozva: ${created} db termék.`,errors});}catch(err){console.error(err);res.status(500).json({error:'Bulk import közben hiba történt.'});}});

export default router;
