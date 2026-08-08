DO $$
DECLARE p bigint;
BEGIN
  IF to_regclass('public.menus') IS NULL THEN RETURN; END IF;
  SELECT id INTO p FROM menus WHERE parent_id IS NULL AND (route='/finance' OR lower(name) LIKE 'pénzügy%') ORDER BY CASE WHEN route='/finance' THEN 0 ELSE 1 END,id LIMIT 1;
  IF p IS NULL THEN RETURN; END IF;
  IF NOT EXISTS(SELECT 1 FROM menus WHERE route='/finance/nav-online-invoice') THEN
    INSERT INTO menus(name,route,icon,parent_id,order_index,required_role) VALUES('NAV Online Számla','/finance/nav-online-invoice','FileCheck2',p,85,'admin');
  ELSE
    UPDATE menus SET name='NAV Online Számla',parent_id=p,order_index=85,required_role='admin' WHERE route='/finance/nav-online-invoice';
  END IF;
END $$;
