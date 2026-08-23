import { Router } from "express";
import db from "../db";
import ensureOnlineBooking from "../booking/ensureOnlineBooking";

const router = Router();

router.get("/global-catalog", async (_req, res) => {
  try {
    await ensureOnlineBooking();
    const [locationsResult, servicesResult] = await Promise.all([
      db.query(`SELECT id::text,name FROM locations WHERE COALESCE(is_active,true)=true ORDER BY name`),
      db.query(`
        SELECT s.id::text,
               s.name,
               COALESCE(s.duration_minutes,30)::int duration_minutes,
               COALESCE(s.promo_price,s.list_price,s.base_price,0)::numeric price,
               COALESCE(bsc.name,st.name,'Egyéb szolgáltatások') category_name,
               COALESCE(
                 array_agg(DISTINCT sl.location_id::text) FILTER (WHERE sl.location_id IS NOT NULL),
                 ARRAY[]::text[]
               ) available_location_ids,
               NOT EXISTS (SELECT 1 FROM service_locations sx WHERE sx.service_id=s.id) available_everywhere
          FROM services s
          LEFT JOIN service_types st ON st.id=s.service_type_id
          LEFT JOIN booking_service_taxonomy bst ON bst.service_id=s.id
          LEFT JOIN booking_service_categories bsc ON bsc.id=bst.category_id AND bsc.is_active=true
          LEFT JOIN service_locations sl ON sl.service_id=s.id
         WHERE s.is_active=true AND COALESCE(s.online_bookable,true)=true
         GROUP BY s.id,s.name,s.duration_minutes,s.promo_price,s.list_price,s.base_price,bsc.name,st.name
         ORDER BY COALESCE(bsc.name,st.name,'Egyéb szolgáltatások'),s.name
      `),
    ]);

    return res.json({ locations: locationsResult.rows, services: servicesResult.rows });
  } catch (error: any) {
    console.error("[booking-global-catalog] failed", error?.message || error);
    return res.status(500).json({ error: "A szolgáltatások nem tölthetők be.", detail: error?.message || String(error) });
  }
});

export default router;
