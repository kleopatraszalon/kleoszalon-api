BEGIN;

-- Az admin VIR-ben minden jelenleg aktív menüpont látható legyen.
-- Korábbi, explicit tiltó admin jogosultságokat felülírjuk, de inaktív/legacy
-- menüket nem aktiválunk újra, így nem hozunk vissza duplikált vagy kivezetett pontokat.
UPDATE role_menu_permissions p
SET can_view = true,
    updated_at = now()
WHERE lower(p.role_key) IN ('admin','administrator','superadmin','super_admin')
  AND EXISTS (
    SELECT 1
    FROM menus m
    WHERE m.id = p.menu_id
      AND COALESCE(m.is_active, true)
  );

-- A kanonikus VIR gyökérmodulok nem tűnhetnek el egy régi migráció vagy
-- menü-testreszabási állapot miatt.
UPDATE menus
SET is_active = true
WHERE code IN (
  'dashboard','appointments','customers','loyalty','team','finance','inventory',
  'procurement','analytics','locations','marketing','online','commerce',
  'operations','knowledge','masterdata','settings'
);

COMMIT;
