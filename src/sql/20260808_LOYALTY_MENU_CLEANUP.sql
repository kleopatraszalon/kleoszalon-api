-- Hűség modul menü tisztítás
-- Eltávolítja a régi/generikus Hűségprogram menüpontot, és az elkészült loyalty oldalakra mutató menüt tartja meg.
DO $$
DECLARE
  p bigint;
BEGIN
  IF to_regclass('public.menus') IS NULL THEN RETURN; END IF;

  SELECT id INTO p
  FROM menus
  WHERE parent_id IS NULL
    AND (route = '/loyalty' OR lower(name) LIKE 'hűség%')
  ORDER BY CASE WHEN route='/loyalty' THEN 0 ELSE 1 END, id
  LIMIT 1;

  IF p IS NULL THEN
    INSERT INTO menus(name,route,icon,parent_id,order_index,required_role)
    VALUES('Hűség, bérletek és ajándékkártyák','/loyalty','Gift',NULL,40,'all')
    RETURNING id INTO p;
  END IF;

  UPDATE menus
     SET name='Hűség, bérletek és ajándékkártyák', route='/loyalty', icon=COALESCE(icon,'Gift')
   WHERE id=p;

  -- Régi scaffold/generikus Program oldal: ne jelenjen meg a Hűség modul alatt.
  DELETE FROM menus
   WHERE parent_id=p
     AND (
       lower(trim(name)) IN ('hűségprogram','program')
       OR route IN ('/modules/loyalty','/modules/loyalty/program','/loyalty/program')
     );

  -- Duplikált / régi elnevezésű elemek összevonása az aktuális oldalakra.
  UPDATE menus SET name='Áttekintés', route='/loyalty', order_index=5 WHERE parent_id=p AND route='/loyalty';
  UPDATE menus SET name='Vendég egyenlegek', route='/loyalty/accounts', order_index=10 WHERE parent_id=p AND route='/loyalty/accounts';
  UPDATE menus SET name='Hűségpontok', route='/loyalty/points', order_index=15 WHERE parent_id=p AND route='/loyalty/points';
  UPDATE menus SET name='Bérletek', route='/loyalty/passes', order_index=20 WHERE parent_id=p AND route='/loyalty/passes';
  UPDATE menus SET name='Kuponok', route='/loyalty/coupons', order_index=30 WHERE parent_id=p AND route='/loyalty/coupons';
  UPDATE menus SET name='Ajándékutalványok', route='/loyalty/vouchers', order_index=40 WHERE parent_id=p AND route='/loyalty/vouchers';
  UPDATE menus SET name='Hűség tranzakciók', route='/loyalty/transactions', order_index=50 WHERE parent_id=p AND route='/loyalty/transactions';
END $$;
