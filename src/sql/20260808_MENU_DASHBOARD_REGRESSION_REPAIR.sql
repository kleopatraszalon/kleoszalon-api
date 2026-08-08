-- Helyreállítás a menü-regresszió után. A cél a kanonikus főmenük és a
-- dashboard által használt aktív navigációs pontok újraaktiválása úgy, hogy
-- az új munkalap- és pénzügyi javítások megmaradjanak.

UPDATE menus SET is_active=true WHERE code IN (
  'dashboard','appointments','appointments.workorders','finance','finance.dashboard','finance.checkout','finance.cash',
  'team','team.schedule','inventory','procurement','settings','commerce.webshop','screens.signage','screens.kiosk',
  'analytics.reports'
);

UPDATE menus SET route='/finance' WHERE code IN ('finance.dashboard','finance.checkout','finance.cash');
UPDATE menus SET route='/workorders' WHERE code='appointments.workorders';
UPDATE menus SET route='/modules/team/timetable' WHERE code='team.schedule';
UPDATE menus SET route='/admin/vir/reports' WHERE code='analytics.reports';
UPDATE menus SET route='/webshop/admin' WHERE code='commerce.webshop';
UPDATE menus SET route='/signage' WHERE code='screens.signage';
UPDATE menus SET route='/kiosk' WHERE code='screens.kiosk';

-- Ha a regressziós deduplikálás egy kanonikus rootot kód nélkül hagyott, a név
-- alapján visszaadjuk a szükséges kódot, de csak akkor, ha a kód még szabad.
DO $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM menus WHERE code='dashboard') THEN
    UPDATE menus SET code='dashboard',is_active=true WHERE id=(SELECT id FROM menus WHERE parent_id IS NULL AND lower(name) IN ('irányítópult','dashboard') ORDER BY id LIMIT 1);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM menus WHERE code='appointments') THEN
    UPDATE menus SET code='appointments',is_active=true WHERE id=(SELECT id FROM menus WHERE parent_id IS NULL AND lower(name) LIKE 'időpont%' ORDER BY id LIMIT 1);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM menus WHERE code='finance') THEN
    UPDATE menus SET code='finance',is_active=true WHERE id=(SELECT id FROM menus WHERE parent_id IS NULL AND lower(name) LIKE 'pénzügy%' ORDER BY id LIMIT 1);
  END IF;
END $$;
