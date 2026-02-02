-- src/sql/public_services_list.sql
-- Nyilvános árlista a marketing oldalnak

SELECT
  s.id,
  s.name,                                    -- szolgáltatás neve
  st.name              AS category_name,     -- kategória (fodrászat, kozmetika, stb.)
  s.short_description,                       -- rövid leírás (ha van)
  s.duration_min,                            -- időtartam percben
  s.price_from                               -- alapár / Ft-tól
FROM public.services s
LEFT JOIN public.service_types st
       ON st.id = s.service_type_id
WHERE COALESCE(s.is_active, TRUE)           -- csak aktív szolgáltatás
  AND COALESCE(s.show_on_web, TRUE)         -- csak webre szánt
ORDER BY st.name NULLS LAST,
         s.name;
