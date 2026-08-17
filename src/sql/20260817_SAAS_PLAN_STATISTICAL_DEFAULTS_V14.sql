BEGIN;

-- VIR SaaS plan quota defaults v14
-- Conservative salon/franchise capacity tiers.
-- Internal and Enterprise remain intentionally unlimited (NULL).
-- Values are explicit product defaults and may later be tuned from production percentiles.

UPDATE subscription_plans
SET max_locations = CASE code
      WHEN 'start' THEN 1
      WHEN 'pro' THEN 5
      WHEN 'franchise' THEN 25
      ELSE max_locations
    END,
    max_users = CASE code
      WHEN 'start' THEN 10
      WHEN 'pro' THEN 50
      WHEN 'franchise' THEN 250
      ELSE max_users
    END
WHERE code IN ('start','pro','franchise');

UPDATE subscription_plans
SET max_locations = NULL,
    max_users = NULL
WHERE code IN ('internal','enterprise');

COMMIT;
