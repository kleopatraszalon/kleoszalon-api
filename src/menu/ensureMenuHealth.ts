import pool from '../db';
import { ensureMenuHealth as ensureLegacyMenuHealth } from './ensureMenuHealthLegacy';

export async function ensureMenuHealth(){
  await ensureLegacyMenuHealth();
  await pool.query(`WITH p AS (SELECT id FROM menus WHERE code='settings' LIMIT 1)
    INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
    SELECT 'settings.audit','Audit és rendszeresemény-napló','ShieldCheck','/modules/settings/audit-log',205,p.id,'audit',true FROM p
    ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,icon=EXCLUDED.icon,route=EXCLUDED.route,order_index=EXCLUDED.order_index,parent_id=EXCLUDED.parent_id,feature_key='audit',is_active=true`);
}
