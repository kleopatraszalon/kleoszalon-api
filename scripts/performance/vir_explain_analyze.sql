-- VIR performance measurement pack
-- Run from a Render/PostgreSQL shell against a representative database.
-- READ-ONLY measurements: no DDL/DML is performed by this file.
-- Example:
-- psql "$DATABASE_URL" -v location_id='00000000-0000-0000-0000-000000000000' -v from_date='2026-07-01' -v to_date='2026-08-16' -f scripts/performance/vir_explain_analyze.sql
\set ON_ERROR_STOP on

\echo '=== environment ==='
SELECT current_database() database_name,current_setting('server_version') postgres_version,current_setting('TimeZone') timezone;

\echo '=== relevant table sizes ==='
SELECT relname,pg_size_pretty(pg_total_relation_size(relid)) total_size,n_live_tup,n_dead_tup,last_analyze,last_autoanalyze
FROM pg_stat_user_tables
WHERE relname IN ('appointments','appointment_services','services','employees','work_orders','management_daily_facts')
ORDER BY pg_total_relation_size(relid) DESC;

\echo '=== relevant index usage ==='
SELECT schemaname,relname table_name,indexrelname index_name,idx_scan,idx_tup_read,idx_tup_fetch,pg_size_pretty(pg_relation_size(indexrelid)) index_size
FROM pg_stat_user_indexes
WHERE relname IN ('appointments','appointment_services','services','employees','work_orders','management_daily_facts')
ORDER BY relname,idx_scan DESC,indexrelname;

\echo '=== index definitions ==='
SELECT tablename,indexname,indexdef FROM pg_indexes
WHERE schemaname='public' AND tablename IN ('appointments','appointment_services','services','employees','work_orders','management_daily_facts')
ORDER BY tablename,indexname;

\echo '=== dashboard summary ==='
EXPLAIN (ANALYZE,BUFFERS,SETTINGS,WAL,SUMMARY,FORMAT TEXT)
SELECT * FROM public.vir_dashboard_summary(:'from_date'::date,:'to_date'::date,:'location_id'::uuid);

\echo '=== revenue series ==='
EXPLAIN (ANALYZE,BUFFERS,SETTINGS,WAL,SUMMARY,FORMAT TEXT)
SELECT * FROM public.vir_revenue_series(:'from_date'::date,:'to_date'::date,:'location_id'::uuid) ORDER BY day;

\echo '=== top services ==='
EXPLAIN (ANALYZE,BUFFERS,SETTINGS,WAL,SUMMARY,FORMAT TEXT)
SELECT s.id service_id,s.name service_name,COUNT(DISTINCT a.id)::int bookings_count,
       COALESCE(SUM(COALESCE(aps.price,0)),0)::numeric(14,2) revenue_total
FROM appointment_services aps JOIN appointments a ON a.id=aps.appointment_id JOIN services s ON s.id=aps.service_id
WHERE a.location_id=:'location_id'::uuid
GROUP BY s.id,s.name ORDER BY revenue_total DESC,bookings_count DESC,s.name LIMIT 10;

\echo '=== top staff ==='
EXPLAIN (ANALYZE,BUFFERS,SETTINGS,WAL,SUMMARY,FORMAT TEXT)
SELECT e.id employee_id,e.full_name,e.short_name,COUNT(DISTINCT a.id)::int appointments_count,
       COALESCE(SUM(COALESCE(aps.price,0)),0)::numeric(14,2) revenue_total
FROM appointments a JOIN employees e ON e.id=a.employee_id LEFT JOIN appointment_services aps ON aps.appointment_id=a.id
WHERE a.location_id=:'location_id'::uuid
GROUP BY e.id,e.full_name,e.short_name ORDER BY revenue_total DESC,appointments_count DESC,e.full_name LIMIT 10;

\echo '=== source performance ==='
EXPLAIN (ANALYZE,BUFFERS,SETTINGS,WAL,SUMMARY,FORMAT TEXT)
SELECT source_channel,location_id,appointments_count,completed_count,cancelled_count,no_show_count,revenue_total,paid_total
FROM public.vw_vir_source_performance WHERE location_id=:'location_id'::uuid
ORDER BY revenue_total DESC NULLS LAST,appointments_count DESC;

\echo '=== cancellation stats ==='
EXPLAIN (ANALYZE,BUFFERS,SETTINGS,WAL,SUMMARY,FORMAT TEXT)
SELECT day,location_id,total_appointments,cancelled_count,no_show_count,cancellation_rate_percent,no_show_rate_percent
FROM public.vw_vir_cancellation_stats
WHERE day BETWEEN :'from_date'::date AND :'to_date'::date AND location_id=:'location_id'::uuid ORDER BY day;

\echo '=== kiosk conversion ==='
EXPLAIN (ANALYZE,BUFFERS,SETTINGS,WAL,SUMMARY,FORMAT TEXT)
SELECT day,location_id,kiosk_appointments,kiosk_completed,kiosk_revenue
FROM public.vw_vir_kiosk_conversion
WHERE day BETWEEN :'from_date'::date AND :'to_date'::date AND location_id=:'location_id'::uuid ORDER BY day;

\echo '=== signage impact ==='
EXPLAIN (ANALYZE,BUFFERS,SETTINGS,WAL,SUMMARY,FORMAT TEXT)
SELECT deal_id,title,location_id,active_from,active_to,appointments_during_campaign,revenue_during_campaign
FROM public.vw_vir_signage_campaign_impact
WHERE location_id=:'location_id'::uuid OR location_id IS NULL
ORDER BY active_from DESC,revenue_during_campaign DESC NULLS LAST;

\echo '=== sequential/index scan diagnostics ==='
SELECT relname,seq_scan,seq_tup_read,idx_scan,idx_tup_fetch,
       CASE WHEN seq_scan+idx_scan=0 THEN 0 ELSE round(100.0*idx_scan/(seq_scan+idx_scan),2) END index_scan_pct
FROM pg_stat_user_tables
WHERE relname IN ('appointments','appointment_services','services','employees','work_orders','management_daily_facts')
ORDER BY seq_tup_read DESC;

-- Index acceptance gate:
-- Add an index only if the representative plan shows a material sequential scan / high rows-removed count
-- on a sufficiently large table, and no equivalent left-prefix index already exists.
-- After adding a candidate, rerun this pack and compare execution time, shared hit/read blocks,
-- scan type, sort method/memory and rows removed by filter. Reject indexes without material benefit.
