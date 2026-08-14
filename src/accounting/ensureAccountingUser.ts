import db from '../db';

const ACCOUNTING_LOGIN='könyvelés';
const ACCOUNTING_EMAIL='konyveles@kleoszalon.hu';
const ACCOUNTING_NAME='Könyvelés';
const ACCOUNTING_PASSWORD_HASH='$2b$12$7yCjqwhiLLMvIH0H8wzDIud7cTOHC.uU2MZUKIDWrYhbzGZvocwsO';

export async function ensureAccountingUser(){
  const roleTypeResult=await db.query(`SELECT udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='role' LIMIT 1`);
  const roleType=String(roleTypeResult.rows[0]?.udt_name||'');
  const existing=await db.query(`SELECT id FROM users WHERE lower(COALESCE(login_name,''))=lower($1) OR lower(COALESCE(email,''))=lower($2) LIMIT 1`,[ACCOUNTING_LOGIN,ACCOUNTING_EMAIL]);
  const roleValue=roleType==='jsonb'||roleType==='json'?'["accounting"]':'accounting';

  if(existing.rows[0]?.id){
    const id=existing.rows[0].id;
    if(roleType==='jsonb') await db.query(`UPDATE users SET full_name=$1,email=$2,login_name=$3,password_hash=$4,role=$5::jsonb,location_id=NULL WHERE id=$6`,[ACCOUNTING_NAME,ACCOUNTING_EMAIL,ACCOUNTING_LOGIN,ACCOUNTING_PASSWORD_HASH,roleValue,id]);
    else if(roleType==='json') await db.query(`UPDATE users SET full_name=$1,email=$2,login_name=$3,password_hash=$4,role=$5::json,location_id=NULL WHERE id=$6`,[ACCOUNTING_NAME,ACCOUNTING_EMAIL,ACCOUNTING_LOGIN,ACCOUNTING_PASSWORD_HASH,roleValue,id]);
    else await db.query(`UPDATE users SET full_name=$1,email=$2,login_name=$3,password_hash=$4,role=$5,location_id=NULL WHERE id=$6`,[ACCOUNTING_NAME,ACCOUNTING_EMAIL,ACCOUNTING_LOGIN,ACCOUNTING_PASSWORD_HASH,roleValue,id]);
    return {created:false,id:String(id)};
  }

  let inserted;
  if(roleType==='jsonb') inserted=await db.query(`INSERT INTO users(full_name,email,login_name,password_hash,role,location_id) VALUES($1,$2,$3,$4,$5::jsonb,NULL) RETURNING id`,[ACCOUNTING_NAME,ACCOUNTING_EMAIL,ACCOUNTING_LOGIN,ACCOUNTING_PASSWORD_HASH,roleValue]);
  else if(roleType==='json') inserted=await db.query(`INSERT INTO users(full_name,email,login_name,password_hash,role,location_id) VALUES($1,$2,$3,$4,$5::json,NULL) RETURNING id`,[ACCOUNTING_NAME,ACCOUNTING_EMAIL,ACCOUNTING_LOGIN,ACCOUNTING_PASSWORD_HASH,roleValue]);
  else inserted=await db.query(`INSERT INTO users(full_name,email,login_name,password_hash,role,location_id) VALUES($1,$2,$3,$4,$5,NULL) RETURNING id`,[ACCOUNTING_NAME,ACCOUNTING_EMAIL,ACCOUNTING_LOGIN,ACCOUNTING_PASSWORD_HASH,roleValue]);
  return {created:true,id:String(inserted.rows[0]?.id||'')};
}
