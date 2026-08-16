import { Router, Response } from "express";
import db from "../db";
import { requireAuth } from "../middleware/auth";
import { requireTenantContext, requireTenantRole, TenantAuthRequest } from "../middleware/tenantContext";

const router = Router();
router.use(requireAuth, requireTenantContext);

router.get("/context", async (req: TenantAuthRequest, res: Response) => {
  try {
    const { rows } = await db.query(
      `SELECT t.id::text AS tenant_id,t.slug,t.name,t.legal_name,t.status,
              t.default_locale,t.default_currency,t.timezone,
              sp.code AS plan_code,sp.name AS plan_name,sp.features AS plan_features,
              s.status AS subscription_status,s.current_period_end,
              tb.app_name,tb.logo_url,tb.primary_color,tb.secondary_color,tb.custom_domain
         FROM tenants t
         LEFT JOIN subscriptions s
           ON s.tenant_id=t.id AND s.status IN ('trial','active','past_due','suspended')
         LEFT JOIN subscription_plans sp ON sp.id=s.plan_id
         LEFT JOIN tenant_branding tb ON tb.tenant_id=t.id
        WHERE t.id=$1::bigint
        LIMIT 1`,
      [req.tenant!.id]
    );

    const featureRows = await db.query(
      `SELECT feature_key,enabled,config
         FROM tenant_features
        WHERE tenant_id=$1::bigint
        ORDER BY feature_key`,
      [req.tenant!.id]
    );

    return res.json({
      ok: true,
      tenant: rows[0] || req.tenant,
      tenant_role: req.tenant!.role,
      feature_overrides: featureRows.rows,
    });
  } catch (error) {
    console.error("[SAAS] context:", error);
    return res.status(500).json({ ok: false, error: "A SaaS kontextus nem tölthető be." });
  }
});

router.get("/franchise-networks", async (req: TenantAuthRequest, res: Response) => {
  try {
    const { rows } = await db.query(
      `SELECT fn.*,
              COUNT(fm.id)::int AS member_count,
              COUNT(fm.id) FILTER (WHERE fm.member_type='owned')::int AS owned_location_count,
              COUNT(fm.id) FILTER (WHERE fm.member_type='franchise')::int AS franchise_location_count
         FROM franchise_networks fn
         LEFT JOIN franchise_members fm
           ON fm.franchise_network_id=fn.id
          AND fm.tenant_id=fn.tenant_id
          AND fm.active=true
        WHERE fn.tenant_id=$1::bigint
        GROUP BY fn.id
        ORDER BY fn.name`,
      [req.tenant!.id]
    );
    return res.json({ ok: true, rows });
  } catch (error) {
    console.error("[SAAS] franchise list:", error);
    return res.status(500).json({ ok: false, error: "A franchise hálózatok nem tölthetők be." });
  }
});

router.post(
  "/franchise-networks",
  requireTenantRole("owner", "admin"),
  async (req: TenantAuthRequest, res: Response) => {
    const code = String(req.body?.code || "").trim().toLowerCase();
    const name = String(req.body?.name || "").trim();
    const ownerLegalName = String(req.body?.owner_legal_name || "").trim() || null;
    const royaltyPercent = Number(req.body?.royalty_percent ?? 0);
    const marketingFeePercent = Number(req.body?.marketing_fee_percent ?? 0);

    if (!code || !name) return res.status(400).json({ ok: false, error: "A kód és a név kötelező." });
    if (!Number.isFinite(royaltyPercent) || royaltyPercent < 0 || royaltyPercent > 100) {
      return res.status(400).json({ ok: false, error: "A royalty százalék 0 és 100 közötti lehet." });
    }
    if (!Number.isFinite(marketingFeePercent) || marketingFeePercent < 0 || marketingFeePercent > 100) {
      return res.status(400).json({ ok: false, error: "A marketing díj százaléka 0 és 100 közötti lehet." });
    }

    try {
      const { rows } = await db.query(
        `INSERT INTO franchise_networks
           (tenant_id,code,name,owner_legal_name,royalty_percent,marketing_fee_percent)
         VALUES ($1::bigint,$2,$3,$4,$5,$6)
         RETURNING *`,
        [req.tenant!.id, code, name, ownerLegalName, royaltyPercent, marketingFeePercent]
      );
      return res.status(201).json({ ok: true, row: rows[0] });
    } catch (error: any) {
      if (error?.code === "23505") return res.status(409).json({ ok: false, error: "Ilyen franchise kód már létezik ennél a tenantnál." });
      console.error("[SAAS] franchise create:", error);
      return res.status(500).json({ ok: false, error: "A franchise hálózat nem hozható létre." });
    }
  }
);

router.post(
  "/franchise-networks/:networkId/members",
  requireTenantRole("owner", "admin"),
  async (req: TenantAuthRequest, res: Response) => {
    const networkId = String(req.params.networkId || "").trim();
    const locationId = String(req.body?.location_id || "").trim();
    const memberType = req.body?.member_type === "owned" ? "owned" : "franchise";
    if (!/^\d+$/.test(networkId) || !/^\d+$/.test(locationId)) {
      return res.status(400).json({ ok: false, error: "Érvénytelen hálózat- vagy telephelyazonosító." });
    }

    try {
      const location = await db.query(
        `SELECT id FROM locations WHERE id::text=$1 AND tenant_id=$2::bigint LIMIT 1`,
        [locationId, req.tenant!.id]
      );
      if (!location.rowCount) {
        return res.status(404).json({ ok: false, error: "A telephely nem ehhez a tenanthoz tartozik." });
      }

      const network = await db.query(
        `SELECT id FROM franchise_networks WHERE id::text=$1 AND tenant_id=$2::bigint LIMIT 1`,
        [networkId, req.tenant!.id]
      );
      if (!network.rowCount) return res.status(404).json({ ok: false, error: "A franchise hálózat nem található." });

      const { rows } = await db.query(
        `INSERT INTO franchise_members
           (tenant_id,franchise_network_id,location_id,member_type,agreement_number,agreement_start,agreement_end,royalty_percent,marketing_fee_percent)
         VALUES ($1::bigint,$2::bigint,$3::bigint,$4,$5,$6::date,$7::date,$8,$9)
         ON CONFLICT (franchise_network_id,location_id)
         DO UPDATE SET
           member_type=EXCLUDED.member_type,
           agreement_number=EXCLUDED.agreement_number,
           agreement_start=EXCLUDED.agreement_start,
           agreement_end=EXCLUDED.agreement_end,
           royalty_percent=EXCLUDED.royalty_percent,
           marketing_fee_percent=EXCLUDED.marketing_fee_percent,
           active=true,
           updated_at=now()
         RETURNING *`,
        [
          req.tenant!.id,
          networkId,
          locationId,
          memberType,
          String(req.body?.agreement_number || "").trim() || null,
          req.body?.agreement_start || null,
          req.body?.agreement_end || null,
          req.body?.royalty_percent ?? null,
          req.body?.marketing_fee_percent ?? null,
        ]
      );
      return res.status(201).json({ ok: true, row: rows[0] });
    } catch (error) {
      console.error("[SAAS] franchise member upsert:", error);
      return res.status(500).json({ ok: false, error: "A franchise telephely nem menthető." });
    }
  }
);

router.get("/locations", async (req: TenantAuthRequest, res: Response) => {
  try {
    const { rows } = await db.query(
      `SELECT l.id,l.name,l.city,l.address,l.is_active,
              fm.franchise_network_id,fm.member_type,fn.name AS franchise_network_name
         FROM locations l
         LEFT JOIN franchise_members fm
           ON fm.location_id::text=l.id::text
          AND fm.tenant_id=$1::bigint
          AND fm.active=true
         LEFT JOIN franchise_networks fn
           ON fn.id=fm.franchise_network_id
          AND fn.tenant_id=fm.tenant_id
        WHERE l.tenant_id=$1::bigint
        ORDER BY l.city NULLS LAST,l.name`,
      [req.tenant!.id]
    );
    return res.json({ ok: true, rows });
  } catch (error) {
    console.error("[SAAS] tenant locations:", error);
    return res.status(500).json({ ok: false, error: "A tenant telephelyei nem tölthetők be." });
  }
});

export default router;
