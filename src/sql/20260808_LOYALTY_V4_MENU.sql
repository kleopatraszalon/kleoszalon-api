DO $$
DECLARE p bigint;
BEGIN
  IF to_regclass('public.menus') IS NULL THEN RETURN; END IF;
  SELECT id INTO p FROM menus WHERE parent_id IS NULL AND route='/loyalty' ORDER BY id LIMIT 1;
  IF p IS NULL THEN RETURN; END IF;
  IF NOT EXISTS(SELECT 1 FROM menus WHERE parent_id=p AND route='/loyalty/sales-rules') THEN
    INSERT INTO menus(name,route,parent_id,order_index,required_role)
    VALUES('Értékesítés és kedvezményszabályok','/loyalty/sales-rules',p,45,'all');
  END IF;
END $$;
