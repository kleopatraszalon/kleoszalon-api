# PROMO v22 applicability invariant

`KLEO-FUN-PROMO-001` uses one canonical resolver for both public display and work-order financial settlement.

An action is applicable only when it is published, the evaluation timestamp is inside `valid_from..valid_until`, its location is global or matches the requested/work-order location, and the customer satisfies the configured audience. Auto-selector campaigns created before v22 remain compatible through `auto_selector_meta.location_id` and `auto_selector_meta.applied_discount_pct`.

For a service-specific action, the percentage discount base is only the matching `work_order_items.service_id` total. The settlement does not blindly stack manual, loyalty and daily-action discounts; it selects the largest applicable discount and records daily-action evidence in the settlement result snapshot.
