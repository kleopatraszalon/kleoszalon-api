import db from '../db';

/**
 * Ensures every salon/location has its own clearly marked fallback legal entity.
 *
 * The fallback is deliberately NOT represented as a real Hungarian company:
 * - entity_type=OTHER
 * - registered_country_code=XX
 * - legal_form=INTERNAL_PLACEHOLDER
 * - tax_number is a deterministic internal technical key, not a claimed HU tax id
 *
 * If a salon already has an active default legal entity, it is left untouched.
 * Otherwise the salon-specific fallback becomes the default. Explicit legal-entity
 * selections on work orders continue to override the location default.
 */
export async function ensureSalonDefaultLegalEntities(){
  const state=(await db.query(`
    SELECT
      to_regclass('public.locations') IS NOT NULL AS locations,
      to_regclass('public.legal_entities') IS NOT NULL AS legal_entities,
      to_regclass('public.legal_entity_locations') IS NOT NULL AS legal_entity_locations
  `)).rows[0]||{};
  if(!state.locations||!state.legal_entities||!state.legal_entity_locations)return;

  await db.query(`
    WITH location_source AS (
      SELECT
        l.id,
        COALESCE(NULLIF(to_jsonb(l)->>'name',''),'Szaloncég') AS location_name,
        COALESCE(NULLIF(to_jsonb(l)->>'postal_code',''),NULLIF(to_jsonb(l)->>'zip_code',''),'0000') AS postal_code,
        COALESCE(NULLIF(to_jsonb(l)->>'city',''),'Ismeretlen') AS city,
        COALESCE(
          NULLIF(to_jsonb(l)->>'address',''),
          NULLIF(to_jsonb(l)->>'address_line',''),
          NULLIF(to_jsonb(l)->>'street_address',''),
          'Belső technikai szaloncég – valós cégadat megadása szükséges'
        ) AS address_line,
        'AUTO-LOCATION-'||l.id::text AS ledger_code,
        'T'||upper(substr(md5(l.id::text),1,10)) AS technical_tax_number,
        'TMP-'||upper(substr(md5(l.id::text),1,6)) AS invoice_prefix,
        'TMP-NY-'||upper(substr(md5(l.id::text),1,4)) AS receipt_prefix
      FROM locations l
    )
    INSERT INTO legal_entities(
      entity_type,legal_name,short_name,legal_form,tax_number,
      registered_country_code,registered_postal_code,registered_city,registered_address_line,
      currency,default_vat_rate,invoice_prefix,receipt_prefix,accounting_ledger_code,
      active,created_by,updated_by
    )
    SELECT
      'OTHER',
      s.location_name||' – alapértelmezett belső cég',
      s.location_name||' – alapértelmezett',
      'INTERNAL_PLACEHOLDER',
      s.technical_tax_number,
      'XX',s.postal_code,s.city,s.address_line,
      'HUF',27,s.invoice_prefix,s.receipt_prefix,s.ledger_code,
      true,'system-default-salon-company','system-default-salon-company'
    FROM location_source s
    WHERE NOT EXISTS(
      SELECT 1 FROM legal_entities e
      WHERE e.accounting_ledger_code=s.ledger_code
         OR (e.created_by='system-default-salon-company' AND e.legal_name=s.location_name||' – alapértelmezett belső cég')
    )
    ON CONFLICT DO NOTHING;

    WITH location_fallback AS (
      SELECT l.id AS location_id,e.id AS legal_entity_id
      FROM locations l
      JOIN legal_entities e ON e.accounting_ledger_code='AUTO-LOCATION-'||l.id::text
      WHERE e.active=true
    )
    INSERT INTO legal_entity_locations(legal_entity_id,location_id,is_default,active)
    SELECT f.legal_entity_id,f.location_id,false,true
    FROM location_fallback f
    ON CONFLICT(legal_entity_id,location_id)
    DO UPDATE SET active=true;

    WITH fallback_links AS (
      SELECT el.legal_entity_id,el.location_id
      FROM legal_entity_locations el
      JOIN legal_entities e ON e.id=el.legal_entity_id
      WHERE el.active=true
        AND e.active=true
        AND e.accounting_ledger_code='AUTO-LOCATION-'||el.location_id::text
    )
    UPDATE legal_entity_locations target
       SET is_default=true
      FROM fallback_links f
     WHERE target.legal_entity_id=f.legal_entity_id
       AND target.location_id=f.location_id
       AND target.active=true
       AND target.is_default=false
       AND NOT EXISTS(
         SELECT 1
         FROM legal_entity_locations existing
         JOIN legal_entities ee ON ee.id=existing.legal_entity_id
         WHERE existing.location_id=target.location_id
           AND existing.active=true
           AND existing.is_default=true
           AND ee.active=true
       );
  `);
}

export default ensureSalonDefaultLegalEntities;
