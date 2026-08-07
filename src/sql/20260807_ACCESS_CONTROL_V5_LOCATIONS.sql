BEGIN;

-- ============================================================
-- TELEPHELY-HATÓKÖR – V5
-- A selected_locations jogosultságokhoz tartós telephely-kijelölés.
-- ============================================================

CREATE TABLE IF NOT EXISTS role_location_permissions (
  role_key text NOT NULL,
  location_id bigint NOT NULL,
  can_access boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_key, location_id)
);

CREATE INDEX IF NOT EXISTS role_location_permissions_location_idx
  ON role_location_permissions(location_id, role_key)
  WHERE can_access = true;

-- Az esetleg törölt szerepkörök régi kijelöléseit takarítsuk ki.
DELETE FROM role_location_permissions rlp
WHERE NOT EXISTS (
  SELECT 1 FROM access_roles ar
  WHERE lower(ar.role_key)=lower(rlp.role_key)
);

-- Az esetleg törölt telephelyek régi kijelöléseit takarítsuk ki.
DELETE FROM role_location_permissions rlp
WHERE NOT EXISTS (
  SELECT 1 FROM locations l
  WHERE l.id::text=rlp.location_id::text
);

-- Adminnak nem kell külön telephelylista: az all_locations scope felülírja.
DELETE FROM role_location_permissions WHERE lower(role_key)='admin';

COMMIT;

-- Ellenőrzés:
-- SELECT rlp.role_key,rlp.location_id,l.name,l.city,rlp.can_access
-- FROM role_location_permissions rlp
-- LEFT JOIN locations l ON l.id::text=rlp.location_id::text
-- ORDER BY rlp.role_key,l.city,l.name;
